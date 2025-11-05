Resume Architect — Quick Start

This repository contains a simple Express backend and a static frontend for the Resume Architect app.

Prerequisites
- Node.js (16+ recommended)
- npm
- MySQL (if you want server-side persistence)

1) Create a .env file
Copy the provided `.env.example` to `.env` at the project root and fill in the values:

- GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET: required for Google OAuth Sign-in.
	- When creating OAuth credentials in Google Cloud Console, set the Authorized redirect URI to:
		`http://localhost:3000/api/auth/google/callback`
- SESSION_SECRET and JWT_SECRET: secrets used for sessions and JWT signing.
- FRONTEND_BASE_URL and APP_BASE_URL: typically `http://localhost:3000` for local dev.
- OPENROUTER_API_KEY: Optional. If not provided, AI features (scoring, suggestions) will be disabled but the server will still run for auth and basic endpoints.
- DB_* variables: optional if you prefer using env for DB credentials. The app currently uses hardcoded DB values in `server.js` unless you modify it.

2) Install dependencies

Open a terminal in the project folder and run:

```powershell
npm install
```

3) Start the server

```powershell
npm start
```

This runs `node server.js`. The server logs will show if the MySQL connection is successful.

4) Open the frontend

Open your browser to `http://localhost:3000` (or the value of FRONTEND_BASE_URL).

5) Testing Google Sign-in

- If `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are set and the server restarted, click "Sign in with Google" in the frontend. The server uses Passport to perform the OAuth handshake. On success the server will redirect back with a JWT and the frontend will verify it with `/api/auth/me`.
- If OAuth is not configured, the server will redirect back with `?error=oauth_not_configured` and the frontend shows a friendly alert.
- If the database is unavailable the server will still run and Google OAuth will fall back to an in-memory user store (useful for local testing). For production you should use a persistent DB.

Notes & Troubleshooting
- If the server exits complaining about MySQL, check your DB credentials and ensure MySQL is running. The server will attempt to query the DB on startup.
- To enable AI features, set `OPENROUTER_API_KEY` in `.env`. If missing, AI calls will warn and the server will continue to run for auth and basic features.
- Do NOT commit `.env` to version control. Use `.gitignore` to exclude it.

Optional improvements you may want next
- Move DB credentials into `process.env` inside `server.js` to avoid hardcoding credentials.
- Use HTTPS and secure cookies in production.
- Use a secrets manager for production secrets.

If you want, I can apply the DB env wiring to `server.js` next and add a simple `env`-based override for the current hardcoded MySQL settings.