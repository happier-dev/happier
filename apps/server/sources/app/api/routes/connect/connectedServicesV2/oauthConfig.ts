import {
  CLAUDE_OAUTH_CLIENT_ID,
  CLAUDE_OAUTH_PROFILE_HEADERS,
  CLAUDE_OAUTH_PROFILE_URL,
  CLAUDE_OAUTH_TOKEN_URL,
  OPENAI_CODEX_CLIENT_ID,
  OPENAI_CODEX_TOKEN_URL,
} from "@happier-dev/protocol";

function resolveNonEmptyEnv(raw: string | undefined, fallback: string): string {
  if (typeof raw !== "string") return fallback;
  const trimmed = raw.trim();
  return trimmed ? trimmed : fallback;
}

export function resolveOpenAiCodexOauthClientId(env: NodeJS.ProcessEnv): string {
  return resolveNonEmptyEnv(env.HAPPIER_CONNECTED_SERVICES_OPENAI_CODEX_OAUTH_CLIENT_ID, OPENAI_CODEX_CLIENT_ID);
}

export function resolveOpenAiCodexOauthTokenUrl(env: NodeJS.ProcessEnv): string {
  return resolveNonEmptyEnv(env.HAPPIER_CONNECTED_SERVICES_OPENAI_CODEX_OAUTH_TOKEN_URL, OPENAI_CODEX_TOKEN_URL);
}

export function resolveClaudeSubscriptionOauthClientId(env: NodeJS.ProcessEnv): string {
  return resolveNonEmptyEnv(env.HAPPIER_CONNECTED_SERVICES_CLAUDE_SUBSCRIPTION_OAUTH_CLIENT_ID, CLAUDE_OAUTH_CLIENT_ID);
}

export function resolveClaudeSubscriptionOauthTokenUrl(env: NodeJS.ProcessEnv): string {
  return resolveNonEmptyEnv(env.HAPPIER_CONNECTED_SERVICES_CLAUDE_SUBSCRIPTION_OAUTH_TOKEN_URL, CLAUDE_OAUTH_TOKEN_URL);
}

export function resolveClaudeSubscriptionOauthProfileMetadata() {
  return Object.freeze({
    endpointUrl: CLAUDE_OAUTH_PROFILE_URL,
    headers: CLAUDE_OAUTH_PROFILE_HEADERS,
    projection: "claude_oauth_profile_entitlement" as const,
  });
}
