const { Pool } = require('pg');
const crypto = require('crypto');

const DEFAULT_ADMIN_PASSWORD = 'admin123';

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

function verifyPassword(password, storedHash) {
  if (!storedHash || !storedHash.includes(':')) return false;
  const [salt, keyHex] = storedHash.split(':');
  const derived = crypto.scryptSync(password, salt, 64);
  const keyBuf = Buffer.from(keyHex, 'hex');
  if (derived.length !== keyBuf.length) return false;
  return crypto.timingSafeEqual(derived, keyBuf);
}

let pool = null;
let dbReady = false;
let dbError = null;
let initPromise = null;

function createPool() {
  if (!process.env.DATABASE_URL) {
    return null;
  }
  const useSSL = !process.env.DATABASE_URL.includes('localhost') && !process.env.DATABASE_URL.includes('127.0.0.1');
  return new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: useSSL ? { rejectUnauthorized: false } : false,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000
  });
}

async function initDatabase() {
  if (dbReady && pool) return true;
  if (initPromise) return initPromise;
  initPromise = _runInitDatabase().finally(() => { initPromise = null; });
  return initPromise;
}

async function _runInitDatabase() {
  pool = createPool();
  if (!pool) {
    dbError = 'DATABASE_URL no está configurada.';
    return false;
  }

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS admin_config (
        id INTEGER PRIMARY KEY DEFAULT 1,
        admin_password_hash TEXT NOT NULL,
        whatsapp_number TEXT NOT NULL DEFAULT '50212345678',
        whatsapp_template TEXT NOT NULL DEFAULT 'Hola, acabo de crear un vídeo tutorial para «{app}» ({duracion}) en DemoVoz. ¿Podrías enviarme un código de descarga MP4?',
        require_whatsapp_permission BOOLEAN NOT NULL DEFAULT TRUE,
        watermark_text TEXT NOT NULL DEFAULT 'Creado con DemoVoz',
        promo_banner_enabled BOOLEAN NOT NULL DEFAULT FALSE,
        promo_banner_text TEXT NOT NULL DEFAULT 'Crea vídeos tutoriales profesionales en minutos con inteligencia artificial.',
        gemini_api_key TEXT NOT NULL DEFAULT '',
        gemini_model TEXT NOT NULL DEFAULT 'gemini-3.8-flash',
        gemini_voice TEXT NOT NULL DEFAULT 'Aoede',
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT single_config_row CHECK (id = 1)
      );
    `);

    await pool.query(`ALTER TABLE admin_config ADD COLUMN IF NOT EXISTS gemini_api_key TEXT NOT NULL DEFAULT '';`);
    await pool.query(`ALTER TABLE admin_config ADD COLUMN IF NOT EXISTS gemini_model TEXT NOT NULL DEFAULT 'gemini-3.8-flash';`);
    await pool.query(`ALTER TABLE admin_config ADD COLUMN IF NOT EXISTS gemini_voice TEXT NOT NULL DEFAULT 'Aoede';`);
    await pool.query(`UPDATE admin_config SET gemini_model = 'gemini-3.8-flash' WHERE gemini_model IN ('gemini-2.5-flash', 'gemini-2.5-pro');`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS export_codes (
        id SERIAL PRIMARY KEY,
        code TEXT NOT NULL UNIQUE,
        max_uses INTEGER NOT NULL DEFAULT 15,
        current_uses INTEGER NOT NULL DEFAULT 0,
        active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS app_metrics (
        id SERIAL PRIMARY KEY,
        event_type TEXT NOT NULL,
        metadata JSONB DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_app_metrics_event_type ON app_metrics (event_type);
    `);

    const existing = await pool.query('SELECT id FROM admin_config WHERE id = 1');
    if (existing.rowCount === 0) {
      const initialHash = hashPassword(DEFAULT_ADMIN_PASSWORD);
      await pool.query(
        `INSERT INTO admin_config (
          id,
          admin_password_hash,
          whatsapp_number,
          whatsapp_template,
          require_whatsapp_permission,
          watermark_text,
          promo_banner_enabled,
          promo_banner_text,
          gemini_api_key,
          gemini_model,
          gemini_voice
        ) VALUES (1, $1, $2, $3, TRUE, $4, FALSE, $5, '', $6, $7)
        ON CONFLICT (id) DO NOTHING`,
        [
          initialHash,
          '50212345678',
          'Hola, acabo de crear un vídeo tutorial para «{app}» ({duracion}) en DemoVoz. ¿Podrías enviarme un código de descarga MP4?',
          'Creado con DemoVoz',
          'Crea vídeos tutoriales profesionales en minutos con inteligencia artificial.',
          'gemini-3.8-flash',
          'Aoede'
        ]
      );
    }

    dbReady = true;
    dbError = null;
    console.log('[DemoVoz] Base de datos PostgreSQL en Neon inicializada correctamente.');
    return true;
  } catch (err) {
    dbError = err.message;
    console.error('[DemoVoz] Error inicializando PostgreSQL en Neon:', err.message);
    return false;
  }
}

function getPool() {
  if (!pool) {
    throw new Error(dbError || 'La base de datos PostgreSQL (DATABASE_URL) no está conectada.');
  }
  return pool;
}

function getDbStatus() {
  return { ready: dbReady, error: dbError };
}

module.exports = {
  initDatabase,
  getPool,
  getDbStatus,
  hashPassword,
  verifyPassword,
  DEFAULT_ADMIN_PASSWORD
};
