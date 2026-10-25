# ZHUO FAN HT — backend (Node + Postgres) pour Render

## Deploye sou Render
1. Mete dosye sa a sou GitHub (nouvo repo).
2. Render → **New → Blueprint** → chwazi repo a (li `render.yaml` otomatikman: web service + Postgres).
3. Ranpli 2 varyab: `ADMIN_EMAIL` (Gmail ou) ak `ADMIN_PASSWORD` (kont admin an kreye li poukont li).
4. Lè deploy fini, louvri `https://TON-APP.onrender.com/` (app la) epi `/token.html` (pou jwenn token admin).
5. Nan Panel Admin → "Vidéo de bienvenue et chaîne" → kole token an → **Publier sur le backend**.

## Lokal
```
cp .env.example .env   # epi ranpli l
npm install && node server.js
```

## API (rezime)
Public: `GET /api/guide` · `/api/catalog` · `/api/top` · `/api/spin/config` · `POST /api/auth/register|login`
Itilizatè (Bearer token): `GET/PATCH /api/me` · `GET/POST /api/payments` · `GET/POST /api/orders` · `POST /api/spin {times:1|5}` · `GET /api/spin/rewards` · `POST /api/spin/rewards/:id/claim`
Admin: `/api/admin/{stats,users,settings,payments,orders,rewards,games,packs,announcements,guide,guide-video}`

## ImageKit
1. imagekit.io → Developer options: kopye Public key, Private key, URL endpoint.
2. Nan Render → Environment, ajoute `IMAGEKIT_PUBLIC_KEY`, `IMAGEKIT_PRIVATE_KEY`, `IMAGEKIT_URL_ENDPOINT`.
3. Upload (admin sèlman): `POST /api/admin/upload?folder=announcements` ak imaj brit (Content-Type image/jpeg|png|webp, 5 Mo max) + `Authorization: Bearer <token>` → retounen `{url}`.
4. Mete `url` sa a nan `img` lè w kreye yon anons (`POST /api/admin/announcements`).
5. Upload dirèk nan navigatè: `GET /api/admin/imagekit-auth` bay token/expire/signature.
