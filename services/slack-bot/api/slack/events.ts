import crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

type Json = Record<string, unknown>;

type QaContext = {
  app: string;
  prNumber: number;
  prUrl?: string;
  owner: string;
  repo: string;
  commit?: string;
  channel?: string;
  iosBuildId?: string;
  androidBuildId?: string;
  iosUpdateGroupId?: string;
  androidUpdateGroupId?: string;
  runtimeIos?: string;
  runtimeAndroid?: string;
};

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN ?? "";
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET ?? "";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? "";
const DEFAULT_GITHUB_REPOSITORY = process.env.GITHUB_REPOSITORY ?? "";

export default async function handler(
  req: IncomingMessage & { body?: unknown },
  res: ServerResponse,
) {
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.end("Method Not Allowed");
    return;
  }

  const rawBody = await readRawBody(req);
  let payload: Json;
  try {
    payload = JSON.parse(rawBody) as Json;
  } catch {
    res.statusCode = 400;
    res.end("Invalid JSON payload");
    return;
  }

  if (payload.type === "url_verification") {
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/plain");
    res.end(String(payload.challenge ?? ""));
    return;
  }

  if (!SLACK_BOT_TOKEN || !SLACK_SIGNING_SECRET || !GITHUB_TOKEN) {
    res.statusCode = 500;
    res.end("Missing required environment variables");
    return;
  }

  const signature = header(req, "x-slack-signature");
  const timestamp = header(req, "x-slack-request-timestamp");

  if (
    !verifySlackSignature(rawBody, signature, timestamp, SLACK_SIGNING_SECRET)
  ) {
    res.statusCode = 401;
    res.end("Invalid signature");
    return;
  }

  // Always acknowledge quickly to prevent Slack retries.
  res.statusCode = 200;
  res.end("ok");

  if (payload.type !== "event_callback") {
    return;
  }

  const event = payload.event as Json | undefined;
  if (!event) return;

  try {
    if (event.type === "reaction_added") {
      await handleReactionAdded(event);
      return;
    }

    if (event.type === "message" && event.channel_type === "channel") {
      await handleChannelThreadMessage(event);
    }
  } catch (error) {
    console.error("Slack event processing failed", error);
  }
}

async function handleReactionAdded(event: Json): Promise<void> {
  const reaction = String(event.reaction ?? "");
  const item = (event.item ?? {}) as Json;
  const channel = String(item.channel ?? "");
  const ts = String(item.ts ?? "");
  const slackUserId = String(event.user ?? "");
  if (!channel || !ts || !reaction) return;

  const parent = await fetchSlackParentMessage(channel, ts);
  if (!parent?.text) return;

  const qa = extractQaContext(parent.text);
  if (!qa) return;

  const actor = await resolveSlackUser(slackUserId);

  if (
    ["white_check_mark", "heavy_check_mark", "check_mark"].includes(reaction)
  ) {
    await removeGithubLabel(qa, "qa:needed");
    await removeGithubLabel(qa, "qa:changes-requested");
    await addGithubLabels(qa, ["qa:approved"]);

    await postSlackThreadMessage(
      channel,
      ts,
      `✅ QA approvato da @${actor}. Label \`qa:approved\` applicata su PR #${qa.prNumber}.`,
    );
    return;
  }

  if (reaction === "x") {
    await removeGithubLabel(qa, "qa:approved");
    await removeGithubLabel(qa, "qa:needed");
    await addGithubLabels(qa, ["qa:changes-requested"]);

    await postSlackThreadMessage(
      channel,
      ts,
      [
        `❌ QA changes requested da @${actor}.`,
        "Rispondi in questo thread con: `qa-feedback: <dettagli>`",
        "Il bot copierà automaticamente il feedback nel PR.",
      ].join("\n"),
    );
    return;
  }

  if (reaction === "bug") {
    await postSlackThreadMessage(
      channel,
      ts,
      [
        `🐛 Bug segnalato da @${actor}.`,
        "Rispondi in questo thread con: `qa-bug: <descrizione bug>`",
        "Il bot creerà automaticamente una GitHub Issue con metadati artefatto.",
      ].join("\n"),
    );
  }
}

async function handleChannelThreadMessage(event: Json): Promise<void> {
  const subtype = String(event.subtype ?? "");
  if (subtype) return;

  const threadTs = String(event.thread_ts ?? "");
  const channel = String(event.channel ?? "");
  const text = String(event.text ?? "").trim();
  const slackUserId = String(event.user ?? "");

  if (!threadTs || !channel || !text || !slackUserId) return;

  const parent = await fetchSlackParentMessage(channel, threadTs);
  if (!parent?.text) return;

  const qa = extractQaContext(parent.text);
  if (!qa) return;

  const actor = await resolveSlackUser(slackUserId);

  if (text.toLowerCase().startsWith("qa-feedback:")) {
    const feedback = text.slice("qa-feedback:".length).trim();
    if (!feedback) return;

    await removeGithubLabel(qa, "qa:approved");
    await removeGithubLabel(qa, "qa:needed");
    await addGithubLabels(qa, ["qa:changes-requested"]);

    await createPrComment(
      qa,
      [
        "## QA feedback from Slack",
        "",
        `Segnalato da: @${actor}`,
        "",
        feedback,
      ].join("\n"),
    );

    await postSlackThreadMessage(
      channel,
      threadTs,
      "📝 Feedback copiato nel PR e label `qa:changes-requested` applicata.",
    );
    return;
  }

  if (text.toLowerCase().startsWith("qa-bug:")) {
    const bug = text.slice("qa-bug:".length).trim();
    if (!bug) return;

    const issueUrl = await createBugIssue(qa, actor, bug);
    await postSlackThreadMessage(
      channel,
      threadTs,
      `🐛 Issue creata: ${issueUrl}`,
    );
  }
}

function verifySlackSignature(
  rawBody: string,
  signature: string,
  timestamp: string,
  signingSecret: string,
): boolean {
  if (!signature || !timestamp) return false;

  const now = Math.floor(Date.now() / 1000);
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > 60 * 5) {
    return false;
  }

  const base = `v0:${timestamp}:${rawBody}`;
  const digest = crypto
    .createHmac("sha256", signingSecret)
    .update(base)
    .digest("hex");
  const expected = `v0=${digest}`;

  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature, "utf8");
  if (a.length !== b.length) return false;

  return crypto.timingSafeEqual(a, b);
}

async function fetchSlackParentMessage(
  channel: string,
  ts: string,
): Promise<{ text?: string } | null> {
  const response = await slackApi("conversations.replies", {
    channel,
    ts,
    limit: 1,
    inclusive: true,
  });

  const messages = (response.messages ?? []) as Json[];
  if (!messages.length) return null;

  const parent = messages[0];
  return {
    text: String(parent.text ?? ""),
  };
}

async function postSlackThreadMessage(
  channel: string,
  threadTs: string,
  text: string,
): Promise<void> {
  await slackApi("chat.postMessage", {
    channel,
    thread_ts: threadTs,
    text,
  });
}

async function resolveSlackUser(userId: string): Promise<string> {
  if (!userId) return "unknown";

  try {
    const response = await slackApi("users.info", { user: userId });
    const user = (response.user ?? {}) as Json;
    return String(
      (user.profile as Json | undefined)?.display_name || user.name || userId,
    );
  } catch {
    return userId;
  }
}

function extractQaContext(text: string): QaContext | null {
  const prMatch = text.match(/PR #(\d+)/i);
  if (!prMatch) return null;

  const prNumber = Number(prMatch[1]);
  if (!Number.isFinite(prNumber)) return null;

  const prUrlMatch = text.match(
    /https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/i,
  );

  let owner = "";
  let repo = "";

  if (prUrlMatch) {
    owner = prUrlMatch[1];
    repo = prUrlMatch[2];
  } else if (DEFAULT_GITHUB_REPOSITORY.includes("/")) {
    const [defaultOwner, defaultRepo] = DEFAULT_GITHUB_REPOSITORY.split("/");
    owner = defaultOwner;
    repo = defaultRepo;
  } else {
    return null;
  }

  const valueOf = (label: string) => {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(`${escaped}:\\s*(.+)$`, "im");
    const match = text.match(regex);
    return match ? match[1].trim() : undefined;
  };

  return {
    app: valueOf("App") ?? "unknown",
    prNumber,
    prUrl: prUrlMatch ? prUrlMatch[0] : undefined,
    owner,
    repo,
    commit: valueOf("Commit"),
    channel: valueOf("Channel"),
    iosBuildId: valueOf("iOS Build ID"),
    androidBuildId: valueOf("Android Build ID"),
    iosUpdateGroupId: valueOf("iOS Update Group ID"),
    androidUpdateGroupId: valueOf("Android Update Group ID"),
    runtimeIos: valueOf("Runtime iOS"),
    runtimeAndroid: valueOf("Runtime Android"),
  };
}

async function addGithubLabels(qa: QaContext, labels: string[]): Promise<void> {
  await githubApi(
    `/repos/${qa.owner}/${qa.repo}/issues/${qa.prNumber}/labels`,
    {
      method: "POST",
      body: { labels },
    },
  );
}

async function removeGithubLabel(qa: QaContext, name: string): Promise<void> {
  try {
    await githubApi(
      `/repos/${qa.owner}/${qa.repo}/issues/${qa.prNumber}/labels/${encodeURIComponent(name)}`,
      {
        method: "DELETE",
      },
    );
  } catch (error) {
    if (error instanceof Error && error.message.includes("404")) {
      return;
    }
    throw error;
  }
}

async function createPrComment(qa: QaContext, body: string): Promise<void> {
  await githubApi(
    `/repos/${qa.owner}/${qa.repo}/issues/${qa.prNumber}/comments`,
    {
      method: "POST",
      body: { body },
    },
  );
}

async function createBugIssue(
  qa: QaContext,
  actor: string,
  bugDescription: string,
): Promise<string> {
  const title = `🐛 QA bug - PR #${qa.prNumber} (${qa.app})`;
  const body = [
    `Segnalato da: @${actor}`,
    `PR: #${qa.prNumber}`,
    qa.prUrl ? `PR URL: ${qa.prUrl}` : null,
    qa.commit ? `Commit: ${qa.commit}` : null,
    qa.channel ? `Channel: ${qa.channel}` : null,
    qa.iosBuildId ? `iOS Build ID: ${qa.iosBuildId}` : null,
    qa.androidBuildId ? `Android Build ID: ${qa.androidBuildId}` : null,
    qa.iosUpdateGroupId ? `iOS Update Group ID: ${qa.iosUpdateGroupId}` : null,
    qa.androidUpdateGroupId
      ? `Android Update Group ID: ${qa.androidUpdateGroupId}`
      : null,
    qa.runtimeIos ? `Runtime iOS: ${qa.runtimeIos}` : null,
    qa.runtimeAndroid ? `Runtime Android: ${qa.runtimeAndroid}` : null,
    "",
    "Descrizione:",
    bugDescription,
  ]
    .filter(Boolean)
    .join("\n");

  const issue = await githubApi(`/repos/${qa.owner}/${qa.repo}/issues`, {
    method: "POST",
    body: {
      title,
      body,
      labels: ["bug", "qa"],
    },
  });

  const issueNumber = Number(issue.number ?? 0);
  const issueUrl = String(issue.html_url ?? "");

  if (issueNumber > 0) {
    await createPrComment(
      qa,
      [
        "## QA bug creato da Slack",
        "",
        `Issue: ${issueUrl}`,
        "",
        bugDescription,
      ].join("\n"),
    );
  }

  return issueUrl;
}

async function slackApi(method: string, body: Json): Promise<Json> {
  const response = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`Slack API ${method} failed (${response.status})`);
  }

  const data = (await response.json()) as Json;
  if (!data.ok) {
    throw new Error(
      `Slack API ${method} error: ${String(data.error ?? "unknown")}`,
    );
  }

  return data;
}

async function githubApi(
  path: string,
  init: { method: string; body?: Json },
): Promise<Json> {
  const response = await fetch(`https://api.github.com${path}`, {
    method: init.method,
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      "Content-Type": "application/json",
      Accept: "application/vnd.github+json",
      "User-Agent": "ergon-mobile-slack-bot",
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });

  if (response.status === 204) {
    return {};
  }

  const data = (await response.json()) as Json;

  if (!response.ok) {
    throw new Error(
      `GitHub API ${path} failed (${response.status}): ${JSON.stringify(data)}`,
    );
  }

  return data;
}

async function readRawBody(
  req: IncomingMessage & { body?: unknown },
): Promise<string> {
  if (typeof req.body === "string") {
    return req.body;
  }

  if (req.body && typeof req.body === "object") {
    return JSON.stringify(req.body);
  }

  const chunks: Uint8Array[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function header(req: IncomingMessage, name: string): string {
  const value = req.headers[name];
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}
