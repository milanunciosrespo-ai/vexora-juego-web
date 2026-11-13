# VEXORA Online 0.0.4

Servicio global de chat en tiempo real y TOPS persistentes para VEXORA Web. Usa Cloudflare Workers con un Durable Object SQLite; no depende de Render.

## Publicar

1. Instala Node.js LTS si todavía no está instalado.
2. Abre PowerShell en esta carpeta y ejecuta `npm install`.
3. Ejecuta `npx wrangler login` y autoriza tu cuenta de Cloudflare.
4. Ejecuta `npm run deploy`.
5. Copia la URL `https://vexora-online.<tu-subdominio>.workers.dev` que indique Wrangler.
6. Abre VEXORA 0.0.4 → Configuración → pega esa URL → Guardar servidor.

La primera publicación crea el Durable Object y su almacenamiento SQLite. `/health` devuelve el estado del servicio. No compartas tokens de cuenta.

## Rutas

- `GET /health`: estado y versión.
- `GET /api/rankings?game=level-1|level-2|cells|drone-rush`: mejores 100 tiempos.
- `POST /api/rankings`: registra o mejora el tiempo de una partida.
- `POST /api/name`: actualiza el nombre del perfil en sus récords.
- `GET /api/chat`: últimos 50 mensajes.
- `WS /ws`: historial inicial y chat global en tiempo real.

Los récords de esta beta no llevan inicio de sesión y el cliente controla el cronómetro, así que no son resistentes a trampas. El endpoint es público para la web de VEXORA; no envíes datos privados al chat.
