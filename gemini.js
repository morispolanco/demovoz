const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

const ALLOWED_MODELS = ['gemini-3.8-flash', 'gemini-4-carbon'];
const ALLOWED_VOICES = ['Aoede', 'Kore', 'Puck', 'Charon', 'Fenrir', 'Leda', 'Orus', 'Zephyr'];

function countWords(text) {
  return (text || '').trim().split(/\s+/).filter(Boolean).length;
}

function calcDurationSec(narration) {
  const words = countWords(narration);
  return Math.max(5, Math.ceil(words / 2.0) + 1);
}

function sanitizeScene(scene, index) {
  const validTypes = ['intro', 'problema', 'funcion', 'beneficio', 'cierre'];
  const tipo = validTypes.includes(scene.tipo) ? scene.tipo : (index === 0 ? 'intro' : 'funcion');
  const narracion = String(scene.narracion_es || 'Descubre cómo esta herramienta simplifica tu trabajo diario.').trim();
  const titulo = String(scene.titulo_grafico || `Escena ${index + 1}`)
    .trim()
    .split(/\s+/)
    .slice(0, 6)
    .join(' ');
  const puntos = Array.isArray(scene.puntos_clave)
    ? scene.puntos_clave.map((p) => String(p).trim()).filter(Boolean).slice(0, 3)
    : ['Flujo guiado y claro', 'Resultados en pocos pasos'];

  return {
    tipo,
    duracion_seg: Math.max(5, Number(scene.duracion_seg) || calcDurationSec(narracion)),
    titulo_grafico: titulo,
    puntos_clave: puntos.length >= 2 ? puntos : [...puntos, 'Diseño claro y accesible'].slice(0, 2),
    icono: String(scene.icono || '✨').trim().slice(0, 4),
    narracion_es: narracion
  };
}

function buildLocalFallbackScript({ appName, description, cta, tone }) {
  const name = (appName || 'Tu aplicación').trim();
  const desc = (description || '').trim();
  const toneAdverb = tone === 'Dinámico' ? 'con agilidad y ritmo' : tone === 'Didáctico' ? 'paso a paso y con claridad' : 'con precisión profesional';
  const rawSentences = desc
    .split(/[\n.!?;]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 10);

  const wordCount = countWords(desc);
  const featureTarget = Math.min(8, Math.max(1, Math.round(wordCount / 22)));
  const icons = ['⚙️', '📊', '⚡', '🔒', '📱', '🤝', '📈', '🧩'];

  const escenas = [];

  const introNarr = `Te presentamos ${name}, una solución creada para ayudarte a trabajar ${toneAdverb}. En este tutorial verás cómo aprovechar sus funciones clave desde el primer minuto.`;
  escenas.push({
    tipo: 'intro',
    duracion_seg: calcDurationSec(introNarr),
    titulo_grafico: `Bienvenido a ${name}`.split(/\s+/).slice(0, 6).join(' '),
    puntos_clave: ['Inicio rápido y sin fricción', 'Interfaz clara en español'],
    icono: '🚀',
    narracion_es: introNarr
  });

  if (wordCount >= 35) {
    const probNarr = `Gestionar tareas diarias con herramientas dispersas consume tiempo y genera errores evitables. ${name} reúne todo el proceso en un solo espacio ordenado.`;
    escenas.push({
      tipo: 'problema',
      duracion_seg: calcDurationSec(probNarr),
      titulo_grafico: 'El reto del día a día',
      puntos_clave: ['Menos tareas repetitivas', 'Información siempre centralizada'],
      icono: '🎯',
      narracion_es: probNarr
    });
  }

  for (let i = 0; i < featureTarget; i++) {
    const sentence = rawSentences[i] || `Función principal ${i + 1} diseñada para optimizar tu flujo de trabajo en ${name}.`;
    const shortTitle = sentence.split(/\s+/).slice(0, 5).join(' ').replace(/[,:;]+$/, '');
    const narr = `${sentence}. Con ${name} puedes aplicar esta función ${toneAdverb}, manteniendo el control total en cada paso.`;
    escenas.push({
      tipo: 'funcion',
      duracion_seg: calcDurationSec(narr),
      titulo_grafico: shortTitle || `Función clave ${i + 1}`,
      puntos_clave: [
        sentence.length > 52 ? `${sentence.slice(0, 49)}…` : sentence,
        'Configuración inmediata y guiada'
      ],
      icono: icons[i % icons.length],
      narracion_es: narr
    });
  }

  if (wordCount >= 50) {
    const benNarr = `Al integrar estas herramientas en tu rutina, ahorras horas cada semana y obtienes resultados consistentes para todo tu equipo.`;
    escenas.push({
      tipo: 'beneficio',
      duracion_seg: calcDurationSec(benNarr),
      titulo_grafico: 'Beneficios medibles desde hoy',
      puntos_clave: ['Ahorro real de tiempo', 'Mejor organización y trazabilidad', 'Listo para crecer contigo'],
      icono: '✅',
      narracion_es: benNarr
    });
  }

  const ctaClean = (cta || '').trim();
  const cierreNarr = ctaClean
    ? `Empieza hoy mismo con ${name}. Visita ${ctaClean} y lleva tu proyecto al siguiente nivel.`
    : `Empieza hoy mismo con ${name} y descubre lo sencillo que es transformar tu flujo de trabajo.`;
  escenas.push({
    tipo: 'cierre',
    duracion_seg: calcDurationSec(cierreNarr),
    titulo_grafico: ctaClean ? 'Comienza hoy mismo' : `Descubre ${name}`.split(/\s+/).slice(0, 6).join(' '),
    puntos_clave: ctaClean ? [ctaClean, 'Disponible en escritorio y móvil'] : ['Prueba inmediata', 'Soporte y mejoras continuas'],
    icono: '✨',
    narracion_es: cierreNarr
  });

  return {
    titulo_app: name,
    eslogan: `Tu guía práctica de ${name}`,
    escenas: escenas.map(sanitizeScene),
    fallback: true
  };
}

async function fetchWithTimeout(url, options, timeoutMs = 24000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function generateScriptWithGemini({ apiKey, appName, description, cta, tone, model }) {
  if (!apiKey) {
    return buildLocalFallbackScript({ appName, description, cta, tone });
  }

  const selectedModel = ALLOWED_MODELS.includes(model) ? model : 'gemini-3.8-flash';
  const wordCount = countWords(description);
  const suggestedScenes = wordCount < 35 ? 'entre 3 y 4 escenas' : wordCount < 85 ? 'entre 5 y 7 escenas' : 'entre 7 y 11 escenas';

  const systemPrompt = `Eres un guionista experto en vídeos tutoriales de software en español neutro natural.
Tu tarea es transformar la descripción de una aplicación en un guion estructurado de vídeo tutorial con duración adaptativa (NO fija).
Reglas estrictas:
1. Determina dinámicamente cuántas escenas crear según la riqueza del texto (sugerencia orientativa: ${suggestedScenes}, siempre entre 3 y 12 escenas).
2. Usa ortotipografía cuidada en español (comillas angulares «», signos de apertura ¿ ¡, títulos con mayúscula solo en la primera palabra y nombres propios).
3. Calcula "duracion_seg" según ~2,0 palabras por segundo de "narracion_es" más 1 segundo de pausa, con un mínimo estricto de 5 segundos por escena.
4. "titulo_grafico" debe tener como máximo 6 palabras.
5. "puntos_clave" debe incluir entre 2 y 3 viñetas muy cortas y escaneables.
6. "tipo" debe ser exactamente uno de: "intro", "problema", "funcion", "beneficio", "cierre". La primera escena debe ser "intro" y la última "cierre".
7. "icono" debe ser un único emoji limpio y pertinente.
8. Devuelve únicamente JSON válido siguiendo el esquema solicitado.`;

  const userPrompt = `Nombre de la aplicación: ${appName}
Tono deseado: ${tone || 'Profesional'}
Sitio web o llamada a la acción para el cierre: ${cta || 'Ninguno especificado'}
Descripción y características principales:
${description}

Devuelve un JSON estricto con esta estructura:
{
  "titulo_app": "string",
  "eslogan": "string breve (máx. 10 palabras)",
  "escenas": [
    {
      "tipo": "intro | problema | funcion | beneficio | cierre",
      "duracion_seg": 6,
      "titulo_grafico": "Máximo 6 palabras",
      "puntos_clave": ["Viñeta corta 1", "Viñeta corta 2"],
      "icono": "🚀",
      "narracion_es": "Texto natural en español neutro para locución."
    }
  ]
}`;

  const url = `${GEMINI_API_BASE}/${selectedModel}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const response = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
      generationConfig: {
        temperature: 0.7,
        responseMimeType: 'application/json'
      }
    })
  }, 30000);

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Gemini respondió con estado ${response.status}: ${errText.slice(0, 240)}`);
  }

  const data = await response.json();
  const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!rawText) {
    throw new Error('Gemini no devolvió contenido en la respuesta.');
  }

  const parsed = JSON.parse(rawText);
  if (!Array.isArray(parsed.escenas) || parsed.escenas.length === 0) {
    throw new Error('El guion generado por Gemini no contiene escenas válidas.');
  }

  return {
    titulo_app: String(parsed.titulo_app || appName).trim(),
    eslogan: String(parsed.eslogan || `Descubre ${appName}`).trim(),
    escenas: parsed.escenas.map(sanitizeScene),
    fallback: false,
    model: selectedModel
  };
}

function pcm16ToWavBase64(pcmBuffer, sampleRate = 24000, numChannels = 1, bitsPerSample = 16) {
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const dataSize = pcmBuffer.length;
  const header = Buffer.alloc(44);

  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcmBuffer]).toString('base64');
}

async function generateAudioWithGeminiTTS({ apiKey, text, voice }) {
  if (!apiKey) {
    return { fallback: true, reason: 'Clave de Google Gemini no configurada.' };
  }

  const voiceName = ALLOWED_VOICES.includes(voice) ? voice : 'Aoede';
  const ttsModel = 'gemini-3.8-flash-tts';
  const url = `${GEMINI_API_BASE}/${ttsModel}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  try {
    let response = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      response = await fetchWithTimeout(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                {
                  text: `Lee en voz alta en español neutro natural y ritmo claro de tutorial: ${text}`
                }
              ]
            }
          ],
          generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: { voiceName }
              }
            }
          }
        })
      }, 24000);

      if (response.ok) break;
      if (response.status === 429 || response.status >= 500) {
        await sleep(1400 * (attempt + 1));
        continue;
      }
      break;
    }

    if (!response || !response.ok) {
      const errText = response ? await response.text() : 'Sin respuesta';
      return {
        fallback: true,
        reason: `Gemini TTS (${response?.status || 'red'}): ${errText.slice(0, 180)}`
      };
    }

    const data = await response.json();
    const inlineData = data?.candidates?.[0]?.content?.parts?.[0]?.inlineData;
    if (!inlineData || !inlineData.data) {
      return { fallback: true, reason: 'La respuesta de Gemini TTS no incluyó pista de audio.' };
    }

    const mimeType = (inlineData.mimeType || 'audio/pcm;rate=24000').toLowerCase();
    if (mimeType.includes('pcm') || mimeType.includes('l16')) {
      const rateMatch = mimeType.match(/rate=(\d+)/i);
      const sampleRate = rateMatch ? parseInt(rateMatch[1], 10) : 24000;
      const pcmBuf = Buffer.from(inlineData.data, 'base64');
      return {
        fallback: false,
        mimeType: 'audio/wav',
        audioBase64: pcm16ToWavBase64(pcmBuf, sampleRate, 1, 16),
        voice: voiceName
      };
    }

    return {
      fallback: false,
      mimeType,
      audioBase64: inlineData.data,
      voice: voiceName
    };
  } catch (err) {
    return { fallback: true, reason: `Error de red con Gemini TTS: ${err.message}` };
  }
}

async function testGeminiConnection({ apiKey, model }) {
  if (!apiKey) {
    return { ok: false, message: 'No hay ninguna clave de Google Gemini guardada ni en GEMINI_API_KEY.' };
  }
  const selectedModel = ALLOWED_MODELS.includes(model) ? model : 'gemini-3.8-flash';
  const url = `${GEMINI_API_BASE}/${selectedModel}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const response = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: 'Responde únicamente con la palabra: CONECTADO' }] }]
    })
  }, 15000);

  if (!response.ok) {
    const errText = await response.text();
    return { ok: false, message: `Error ${response.status}: ${errText.slice(0, 200)}` };
  }

  const data = await response.json();
  const reply = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || 'OK';
  return { ok: true, model: selectedModel, message: `Conexión exitosa con ${selectedModel} (${reply}).` };
}

module.exports = {
  generateScriptWithGemini,
  generateAudioWithGeminiTTS,
  testGeminiConnection,
  buildLocalFallbackScript,
  ALLOWED_MODELS,
  ALLOWED_VOICES
};
