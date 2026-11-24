# DemoVoz (listo para GitHub + Vercel + Neon + Google Gemini)

Generador automático de vídeos tutoriales en español con gráficos animados 16:9, narración con **Google Gemini** (`gemini-3.8-flash`, `gemini-4-carbon` y `gemini-3.8-flash-tts`), exportación MP4 con audio y persistencia en **PostgreSQL en Neon**.

## Despliegue en GitHub y Vercel (paso a paso)

1. **Sube este proyecto a GitHub:**
   - Descomprime el archivo `demovoz-vercel.zip` y sube el contenido de la carpeta a un repositorio nuevo en GitHub (el archivo `.gitignore` ya protege `.env` y `node_modules`).
2. **Importa el repositorio en Vercel:**
   - Entra a [vercel.com/new](https://vercel.com/new), selecciona tu repositorio de GitHub y deja la configuración de framework en **Other** (sin comando de build).
3. **Configura las variables de entorno en Vercel** (*Settings → Environment Variables*):
   - `DATABASE_URL`: cadena de conexión de tu base de datos PostgreSQL en [Neon](https://neon.tech) (`postgresql://...?sslmode=require`).
   - `GEMINI_API_KEY`: tu clave `AIzaSy…` de [Google AI Studio](https://aistudio.google.com/) (también puedes cambiarla después desde el panel de administración).
   - `SESSION_SECRET`: cualquier texto largo y aleatorio para firmar las cookies HTTP-only de administrador.
4. **Despliega (*Deploy*) y verifica:**
   - Abre `https://tu-proyecto.vercel.app/api/health`. Debe responder `"ok": true`, `"database": { "ready": true }` y `"geminiConfigured": true`.
   - Al recibir la primera petición, el servidor crea automáticamente en Neon las tablas `admin_config`, `export_codes` (límite predeterminado de 15 vídeos) y `app_metrics`.

## Panel de administración

- Accede pulsando **`Ctrl + Shift + A`**, haciendo **5 clics rápidos** en el logotipo «DemoVoz» o desde **«Administración»** en el pie de página.
- Clave inicial: `admin123` (cámbiala en «5. Seguridad y sesión»).
- Mientras la sesión de administrador esté activa, las descargas salen en HD sin marca de agua y sin bloqueo de WhatsApp; pulsa **«Salir (probar como usuario)»** en la barra superior para verificar el modal de WhatsApp y los códigos de 15 vídeos.

## Ejecución local (opcional)

```bash
npm install
cp .env.example .env
npm start
```
