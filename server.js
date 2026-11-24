require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const path = require('path');

const {
  initDatabase,
  getPool,
  getDbStatus,
  hashPassword,
  verifyPassword,
  DEFAULT_ADMIN_PASSWORD
} = require('./db');
const {
  generateScriptWithGemini,
  generateAudioWithGeminiTTS,
  testGeminiConnection,
  buildLocalFallbackScript,
  ALLOWED_MODELS,
  ALLOWED_VOICES
} = require('./gemini');

const app = express();
const PORT = process.env.PORT || 3000;
const SESSION_COOKIE = 'demovoz_admin_session';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.createHash('sha256').update(process.env.DATABASE_URL || 'demovoz-dev-secret').digest('hex');

app.use(express.json({ limit: '5mb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

function maskApiKey(key) {
  if (!key) return '';
  if (key.length <= 12) return '••••••••';
  return `${key.slice(0, 6)}••••${key.slice(-4)}`;
}

function resolveGeminiKey(configRow) {
  const fromDb = (configRow?.gemini_api_key || '').trim();
  if (fromDb) return { key: fromDb, source: 'admin' };
  const fromEnv = (process.env.GEMINI_API_KEY || '').trim();
  if (fromEnv) return { key: fromEnv, source: 'env' };
  return { key: '', source: 'none' };
}

function signSession(payloadObj) {
  const payload = Buffer.from(JSON.stringify(payloadObj)).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function verifySession(token) {
  if (!token || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return null;
  }
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!parsed.exp || Date.now() > parsed.exp) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function isRequestAdmin(req) {
  const token = req.cookies?.[SESSION_COOKIE];
  const session = verifySession(token);
  if (!session || !session.admin) return false;
  try {
    const pool = getPool();
    const res = await pool.query('SELECT admin_password_hash FROM admin_config WHERE id = 1');
    if (res.rowCount === 0) return false;
    const currentHashPrefix = res.rows[0].admin_password_hash.slice(0, 16);
    return session.hp === currentHashPrefix;
  } catch {
    return false;
  }
}

async function requireAdmin(req, res, next) {
  const ok = await isRequestAdmin(req);
  if (!ok) {
    return res.status(401).json({ error: 'Sesión de administrador no válida o expirada.' });
  }
  next();
}

async function getAdminConfigRow() {
  const ready = await initDatabase();
  if (!ready) return null;
  const pool = getPool();
  const result = await pool.query('SELECT * FROM admin_config WHERE id = 1');
  return result.rows[0] || null;
}

async function recordMetric(eventType, metadata = {}) {
  const allowed = ['visit', 'tutorial_generated', 'whatsapp_requested', 'code_validated', 'mp4_exported'];
  if (!allowed.includes(eventType)) return;
  try {
    const ready = await initDatabase();
    if (!ready) return;
    await getPool().query(
      'INSERT INTO app_metrics (event_type, metadata) VALUES ($1, $2::jsonb)',
      [eventType, JSON.stringify(metadata || {})]
    );
  } catch (err) {
    console.error('[DemoVoz] No se pudo registrar métrica:', err.message);
  }
}

// --- Endpoints públicos ---

app.get('/api/health', async (_req, res) => {
  const config = await getAdminConfigRow();
  const keyInfo = resolveGeminiKey(config);
  res.json({
    ok: true,
    database: getDbStatus(),
    geminiConfigured: Boolean(keyInfo.key)
  });
});

app.get('/api/public-config', async (req, res) => {
  try {
    const config = await getAdminConfigRow();
    const isAdmin = await isRequestAdmin(req);
    const keyInfo = resolveGeminiKey(config);

    if (!config) {
      return res.json({
        whatsapp_number: '50212345678',
        whatsapp_template: 'Hola, acabo de crear un vídeo tutorial para «{app}» ({duracion}) en DemoVoz. ¿Podrías enviarme un código de descarga MP4?',
        require_whatsapp_permission: true,
        watermark_text: 'Creado con DemoVoz',
        promo_banner_enabled: false,
        promo_banner_text: '',
        is_admin: false,
        has_gemini_key: Boolean(keyInfo.key),
        db_connected: false
      });
    }

    res.json({
      whatsapp_number: config.whatsapp_number,
      whatsapp_template: config.whatsapp_template,
      require_whatsapp_permission: config.require_whatsapp_permission,
      watermark_text: config.watermark_text,
      promo_banner_enabled: config.promo_banner_enabled,
      promo_banner_text: config.promo_banner_text,
      is_admin: isAdmin,
      has_gemini_key: Boolean(keyInfo.key),
      db_connected: true
    });
  } catch (err) {
    res.status(500).json({ error: 'No se pudo cargar la configuración pública.', details: err.message });
  }
});

app.post('/api/metrics', async (req, res) => {
  const { event_type, metadata } = req.body || {};
  await recordMetric(event_type, metadata);
  res.json({ ok: true });
});

app.post('/api/generate-script', async (req, res) => {
  try {
    const { appName, description, cta, tone } = req.body || {};
    if (!appName || !description || description.trim().length < 15) {
      return res.status(400).json({
        error: 'Indica el nombre de la aplicación y una descripción de al menos 15 caracteres.'
      });
    }

    const config = await getAdminConfigRow();
    const { key: apiKey } = resolveGeminiKey(config);
    const model = config?.gemini_model || 'gemini-2.5-flash';

    let result;
    try {
      result = await generateScriptWithGemini({ apiKey, appName, description, cta, tone, model });
    } catch (geminiErr) {
      console.warn('[DemoVoz] Respaldo local activado tras error de Gemini:', geminiErr.message);
      result = buildLocalFallbackScript({ appName, description, cta, tone });
      result.warning = `Se activó el modo local de respaldo (${geminiErr.message}).`;
    }

    await recordMetric('tutorial_generated', {
      appName: appName.slice(0, 60),
      scenes: result.escenas.length,
      fallback: Boolean(result.fallback)
    });

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Error al generar el guion del vídeo.', details: err.message });
  }
});

app.post('/api/generate-audio', async (req, res) => {
  try {
    const { text } = req.body || {};
    if (!text || !text.trim()) {
      return res.status(400).json({ error: 'Falta el texto de narración para generar el audio.' });
    }

    const config = await getAdminConfigRow();
    const adminOk = await isRequestAdmin(req);
    const { key: envOrDbKey } = resolveGeminiKey(config);
    const apiKey = (adminOk && req.body?.apiKey) ? String(req.body.apiKey).trim() : envOrDbKey;
    const voice = (adminOk && req.body?.voice) ? String(req.body.voice).trim() : (config?.gemini_voice || 'Aoede');

    const audioResult = await generateAudioWithGeminiTTS({
      apiKey,
      text: text.trim(),
      voice
    });
    res.json(audioResult);
  } catch (err) {
    res.json({ fallback: true, reason: `Error inesperado en síntesis de voz: ${err.message}` });
  }
});

app.post('/api/validate-code', async (req, res) => {
  const rawCode = String(req.body?.code || '').trim().toUpperCase();
  if (!rawCode) {
    return res.status(400).json({ valid: false, error: 'Introduce un código de descarga.' });
  }

  try {
    const ready = await initDatabase();
    if (!ready) {
      return res.status(503).json({ valid: false, error: 'Base de datos Neon no conectada.' });
    }
    const pool = getPool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const found = await client.query(
        'SELECT * FROM export_codes WHERE UPPER(code) = $1 FOR UPDATE',
        [rawCode]
      );

      if (found.rowCount === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ valid: false, error: 'El código introducido no existe.' });
      }

      const row = found.rows[0];
      if (!row.active) {
        await client.query('ROLLBACK');
        return res.status(403).json({ valid: false, error: 'Este código ya fue agotado o revocado.' });
      }

      if (row.max_uses > 0 && row.current_uses >= row.max_uses) {
        await client.query('UPDATE export_codes SET active = FALSE WHERE id = $1', [row.id]);
        await client.query('COMMIT');
        return res.status(403).json({ valid: false, error: 'Este código alcanzó el límite máximo de usos.' });
      }

      const nextUses = row.current_uses + 1;
      const stillActive = row.max_uses === 0 ? true : nextUses < row.max_uses;

      await client.query(
        'UPDATE export_codes SET current_uses = $1, active = $2 WHERE id = $3',
        [nextUses, stillActive, row.id]
      );
      await client.query(
        "INSERT INTO app_metrics (event_type, metadata) VALUES ('code_validated', $1::jsonb)",
        [JSON.stringify({ code: row.code })]
      );
      await client.query('COMMIT');

      res.json({
        valid: true,
        remaining_uses: row.max_uses === 0 ? null : Math.max(0, row.max_uses - nextUses),
        message: row.max_uses === 0
          ? 'Código ilimitado validado. Descarga MP4 desbloqueada.'
          : `Código validado (${nextUses}/${row.max_uses} usos). Descarga MP4 desbloqueada.`
      });
    } catch (txErr) {
      await client.query('ROLLBACK');
      throw txErr;
    } finally {
      client.release();
    }
  } catch (err) {
    res.status(500).json({ valid: false, error: 'Error al validar el código en Neon.', details: err.message });
  }
});

// --- Endpoints de autenticación y administración ---

app.post('/api/admin/login', async (req, res) => {
  try {
    const { password } = req.body || {};
    if (!password) {
      return res.status(400).json({ error: 'Introduce la contraseña de administrador.' });
    }

    const config = await getAdminConfigRow();
    if (!config) {
      return res.status(503).json({ error: 'Base de datos Neon no conectada.' });
    }

    const valid = verifyPassword(password, config.admin_password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Contraseña incorrecta.' });
    }

    const token = signSession({
      admin: true,
      hp: config.admin_password_hash.slice(0, 16),
      exp: Date.now() + 7 * 24 * 60 * 60 * 1000
    });

    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 7 * 24 * 60 * 60 * 1000
    });

    res.json({
      ok: true,
      isDefaultPassword: verifyPassword(DEFAULT_ADMIN_PASSWORD, config.admin_password_hash)
    });
  } catch (err) {
    res.status(500).json({ error: 'Error al iniciar sesión.', details: err.message });
  }
});

app.post('/api/admin/logout', (_req, res) => {
  res.clearCookie(SESSION_COOKIE);
  res.json({ ok: true });
});

app.get('/api/admin/config', requireAdmin, async (_req, res) => {
  try {
    const config = await getAdminConfigRow();
    const keyInfo = resolveGeminiKey(config);
    res.json({
      whatsapp_number: config.whatsapp_number,
      whatsapp_template: config.whatsapp_template,
      require_whatsapp_permission: config.require_whatsapp_permission,
      watermark_text: config.watermark_text,
      promo_banner_enabled: config.promo_banner_enabled,
      promo_banner_text: config.promo_banner_text,
      gemini_model: config.gemini_model || 'gemini-2.5-flash',
      gemini_voice: config.gemini_voice || 'Aoede',
      gemini_key_masked: maskApiKey(keyInfo.key),
      gemini_key_source: keyInfo.source,
      has_gemini_key: Boolean(keyInfo.key),
      updated_at: config.updated_at,
      isDefaultPassword: verifyPassword(DEFAULT_ADMIN_PASSWORD, config.admin_password_hash)
    });
  } catch (err) {
    res.status(500).json({ error: 'No se pudo obtener la configuración.', details: err.message });
  }
});

app.put('/api/admin/config', requireAdmin, async (req, res) => {
  try {
    const {
      whatsapp_number,
      whatsapp_template,
      require_whatsapp_permission,
      watermark_text,
      promo_banner_enabled,
      promo_banner_text,
      gemini_api_key,
      clear_gemini_key,
      gemini_model,
      gemini_voice
    } = req.body || {};

    const cleanPhone = String(whatsapp_number || '').replace(/[^\d]/g, '') || '50212345678';
    const model = ALLOWED_MODELS.includes(gemini_model) ? gemini_model : 'gemini-2.5-flash';
    const voice = ALLOWED_VOICES.includes(gemini_voice) ? gemini_voice : 'Aoede';

    const current = await getAdminConfigRow();
    let nextKey = current?.gemini_api_key || '';
    if (clear_gemini_key) {
      nextKey = '';
    } else if (typeof gemini_api_key === 'string' && gemini_api_key.trim()) {
      nextKey = gemini_api_key.trim();
    }

    const pool = getPool();
    await pool.query(
      `UPDATE admin_config
       SET whatsapp_number = $1,
           whatsapp_template = $2,
           require_whatsapp_permission = $3,
           watermark_text = $4,
           promo_banner_enabled = $5,
           promo_banner_text = $6,
           gemini_api_key = $7,
           gemini_model = $8,
           gemini_voice = $9,
           updated_at = NOW()
       WHERE id = 1`,
      [
        cleanPhone,
        String(whatsapp_template || ''),
        Boolean(require_whatsapp_permission),
        String(watermark_text || ''),
        Boolean(promo_banner_enabled),
        String(promo_banner_text || ''),
        nextKey,
        model,
        voice
      ]
    );

    res.json({ ok: true, message: 'Configuración de Google Gemini y permisos guardada en Neon.' });
  } catch (err) {
    res.status(500).json({ error: 'No se pudo actualizar la configuración.', details: err.message });
  }
});

app.post('/api/admin/password', requireAdmin, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword || newPassword.length < 6) {
      return res.status(400).json({ error: 'La nueva contraseña debe tener al menos 6 caracteres.' });
    }

    const config = await getAdminConfigRow();
    if (!verifyPassword(currentPassword, config.admin_password_hash)) {
      return res.status(401).json({ error: 'La contraseña actual no coincide.' });
    }

    const nextHash = hashPassword(newPassword);
    await getPool().query('UPDATE admin_config SET admin_password_hash = $1, updated_at = NOW() WHERE id = 1', [nextHash]);

    const token = signSession({
      admin: true,
      hp: nextHash.slice(0, 16),
      exp: Date.now() + 7 * 24 * 60 * 60 * 1000
    });
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 7 * 24 * 60 * 60 * 1000
    });

    res.json({ ok: true, message: 'Contraseña de administrador actualizada.' });
  } catch (err) {
    res.status(500).json({ error: 'Error al cambiar la contraseña.', details: err.message });
  }
});

app.post('/api/admin/test-gemini', requireAdmin, async (req, res) => {
  try {
    const config = await getAdminConfigRow();
    const overrideKey = String(req.body?.apiKey || '').trim();
    const keyToUse = overrideKey || resolveGeminiKey(config).key;
    const model = req.body?.model || config?.gemini_model || 'gemini-2.5-flash';
    const result = await testGeminiConnection({ apiKey: keyToUse, model });
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

app.get('/api/admin/codes', requireAdmin, async (_req, res) => {
  try {
    const result = await getPool().query(
      'SELECT id, code, max_uses, current_uses, active, created_at FROM export_codes ORDER BY created_at DESC LIMIT 100'
    );
    res.json({ codes: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'No se pudieron obtener los códigos.', details: err.message });
  }
});

app.post('/api/admin/codes', requireAdmin, async (req, res) => {
  try {
    const rawCode = String(req.body?.code || '').trim().toUpperCase();
    const parsedMax = parseInt(req.body?.max_uses ?? 15, 10);
    const maxUses = Number.isNaN(parsedMax) ? 15 : Math.max(0, parsedMax);
    const code = rawCode || `DV-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;

    const result = await getPool().query(
      'INSERT INTO export_codes (code, max_uses, current_uses, active) VALUES ($1, $2, 0, TRUE) RETURNING *',
      [code, maxUses]
    );
    res.json({ ok: true, code: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Ese código ya existe. Prueba con otro.' });
    }
    res.status(500).json({ error: 'No se pudo crear el código.', details: err.message });
  }
});

app.delete('/api/admin/codes/:id', requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'ID inválido.' });
    await getPool().query('UPDATE export_codes SET active = FALSE WHERE id = $1', [id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'No se pudo revocar el código.', details: err.message });
  }
});

app.get('/api/admin/metrics', requireAdmin, async (_req, res) => {
  try {
    const result = await getPool().query(
      'SELECT event_type, COUNT(*)::int AS total FROM app_metrics GROUP BY event_type'
    );
    const counts = {
      visit: 0,
      tutorial_generated: 0,
      whatsapp_requested: 0,
      code_validated: 0,
      mp4_exported: 0
    };
    for (const row of result.rows) {
      if (Object.prototype.hasOwnProperty.call(counts, row.event_type)) {
        counts[row.event_type] = row.total;
      }
    }
    res.json({ metrics: counts });
  } catch (err) {
    res.status(500).json({ error: 'No se pudieron consultar las métricas.', details: err.message });
  }
});

app.post('/api/admin/metrics/reset', requireAdmin, async (_req, res) => {
  try {
    await getPool().query('TRUNCATE TABLE app_metrics RESTART IDENTITY');
    res.json({ ok: true, message: 'Estadísticas reiniciadas.' });
  } catch (err) {
    res.status(500).json({ error: 'No se pudieron reiniciar las estadísticas.', details: err.message });
  }
});

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

if (require.main === module) {
  initDatabase().finally(() => {
    app.listen(PORT, () => {
      console.log(`[DemoVoz] Servidor ejecutándose en http://localhost:${PORT}`);
    });
  });
}

module.exports = app;
