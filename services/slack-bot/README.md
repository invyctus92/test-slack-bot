# Slack Bot Service (Next.js)

Servizio Next.js che espone l'endpoint Slack Events per sincronizzare QA Slack -> GitHub.

Endpoint:

- `/api/slack/events`

Handler:

- `services/slack-bot/app/api/slack/events/route.ts`

## Avvio locale

1. Vai nella cartella `services/slack-bot`.
2. Installa dipendenze: `npm install`.
3. Avvia in dev: `npm run dev`.

URL locale:

- `http://localhost:3000/api/slack/events`

## Deploy consigliato su Vercel

1. Crea un nuovo progetto su Vercel.
2. Collega questo repository.
3. Imposta `Root Directory` a `services/slack-bot`.
4. Framework Preset: `Next.js`.
5. Deploy.

URL finale atteso:

- `https://<nome-progetto>.vercel.app/api/slack/events`

## Variabili ambiente (Vercel)

- `SLACK_BOT_TOKEN`
- `SLACK_SIGNING_SECRET`
- `GITHUB_APP_ID`
- `GITHUB_APP_PRIVATE_KEY` (chiave PEM della GitHub App; se salvata su una singola riga usa `\n` per i newline)
- `GITHUB_APP_INSTALLATION_ID` (opzionale, consigliata per evitare lookup runtime)
- `GITHUB_REPOSITORY` (opzionale, formato `owner/repo`)

## Config Slack App

In Slack App -> Event Subscriptions:

- abilita Events
- imposta Request URL a `https://<nome-progetto>.vercel.app/api/slack/events`
- subscribe agli eventi bot:
  - `reaction_added`
  - `message.channels`

OAuth scopes minimi:

- `reactions:read`
- `channels:history`
- `chat:write`
- `users:read`

Se usi anche webhook in GitHub Actions, mantieni pure:

- `incoming-webhook`

## Permessi consigliati per GitHub App

Repository permissions della GitHub App:

- Issues: Read and write
- Pull requests: Read and write
- Metadata: Read-only

Installa la GitHub App sul repository target. Il bot genera JWT dell'app e usa un installation access token per ogni chiamata API.
