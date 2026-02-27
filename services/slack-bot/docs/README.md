# Slack Events Bot

Serverless endpoint for Slack -> GitHub QA actions.

Path: `/api/slack/events`

Source: `app/api/slack/events/route.ts`

Environment variables:

- `SLACK_BOT_TOKEN`
- `SLACK_SIGNING_SECRET`
- `GITHUB_APP_ID`
- `GITHUB_APP_PRIVATE_KEY`
- `GITHUB_APP_INSTALLATION_ID` (optional, recommended)
- `GITHUB_REPOSITORY` (optional fallback, format `owner/repo`)

Supported actions:

- Reaction `✅` (`white_check_mark`) on QA message -> adds `qa:approved`
- Reaction `❌` (`x`) -> adds `qa:changes-requested` and asks for thread details
- Reaction `🐛` (`bug`) -> asks for thread bug details
- Thread reply `qa-feedback: ...` -> posts PR comment + `qa:changes-requested`
- Thread reply `qa-bug: ...` -> creates GitHub issue with artifact metadata + links it in PR
