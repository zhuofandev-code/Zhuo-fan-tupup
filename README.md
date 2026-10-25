# ZHUO FAN HT — backend (Node + Postgres) pour Render

## Deploye sou Render
1. Mete dosye sa a sou GitHub (nouvo repo).
2. Render → **New → Blueprint** → chwazi repo a (li `render.yaml` otomatikman: web service + Postgres).
3. Ranpli 2 varyab: `ADMIN_PSEUDO` ak `ADMIN_PASSWORD` (kont admin an kreye li poukont li).
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
