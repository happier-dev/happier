import {
  AGY_OAUTH_CLIENT_ID,
  AGY_OAUTH_CLIENT_SECRET,
  AGY_OAUTH_TOKEN_URL,
  CLAUDE_OAUTH_CLIENT_ID,
  CLAUDE_OAUTH_TOKEN_URL,
  GEMINI_CLI_OAUTH_CLIENT_ID,
  GEMINI_CLI_OAUTH_CLIENT_SECRET,
  GEMINI_CLI_OAUTH_TOKEN_URL,
  OPENAI_CODEX_OAUTH_CLIENT_ID,
  OPENAI_CODEX_OAUTH_TOKEN_URL,
} from "@happier-dev/agents";

// Antigravity profiles deliberately use the verified native issuer only.
export function resolveAntigravityOauthConfig(): Readonly<{ clientId: string; clientSecret: string; tokenUrl: string }> {
  return { clientId: AGY_OAUTH_CLIENT_ID, clientSecret: AGY_OAUTH_CLIENT_SECRET, tokenUrl: AGY_OAUTH_TOKEN_URL };
}

function resolveNonEmptyEnv(raw: string | undefined, fallback: string): string {
  if (typeof raw !== "string") return fallback;
  const trimmed = raw.trim();
  return trimmed ? trimmed : fallback;
}

export function resolveOpenAiCodexOauthClientId(env: NodeJS.ProcessEnv): string {
  return resolveNonEmptyEnv(env.HAPPIER_CONNECTED_SERVICES_OPENAI_CODEX_OAUTH_CLIENT_ID, OPENAI_CODEX_OAUTH_CLIENT_ID);
}

export function resolveOpenAiCodexOauthTokenUrl(env: NodeJS.ProcessEnv): string {
  return resolveNonEmptyEnv(env.HAPPIER_CONNECTED_SERVICES_OPENAI_CODEX_OAUTH_TOKEN_URL, OPENAI_CODEX_OAUTH_TOKEN_URL);
}

export function resolveGeminiOauthClientId(env: NodeJS.ProcessEnv): string {
  return resolveNonEmptyEnv(env.HAPPIER_CONNECTED_SERVICES_GEMINI_OAUTH_CLIENT_ID, GEMINI_CLI_OAUTH_CLIENT_ID);
}

export function resolveGeminiOauthClientSecret(env: NodeJS.ProcessEnv): string {
  return resolveNonEmptyEnv(env.HAPPIER_CONNECTED_SERVICES_GEMINI_OAUTH_CLIENT_SECRET, GEMINI_CLI_OAUTH_CLIENT_SECRET);
}

export function resolveGeminiOauthTokenUrl(env: NodeJS.ProcessEnv): string {
  return resolveNonEmptyEnv(env.HAPPIER_CONNECTED_SERVICES_GEMINI_OAUTH_TOKEN_URL, GEMINI_CLI_OAUTH_TOKEN_URL);
}

export function resolveClaudeSubscriptionOauthClientId(env: NodeJS.ProcessEnv): string {
  return resolveNonEmptyEnv(env.HAPPIER_CONNECTED_SERVICES_CLAUDE_SUBSCRIPTION_OAUTH_CLIENT_ID, CLAUDE_OAUTH_CLIENT_ID);
}

export function resolveClaudeSubscriptionOauthTokenUrl(env: NodeJS.ProcessEnv): string {
  return resolveNonEmptyEnv(env.HAPPIER_CONNECTED_SERVICES_CLAUDE_SUBSCRIPTION_OAUTH_TOKEN_URL, CLAUDE_OAUTH_TOKEN_URL);
}
