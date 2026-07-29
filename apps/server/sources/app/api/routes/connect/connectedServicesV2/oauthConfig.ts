import { CLAUDE_OAUTH_TOKEN_URL } from "@happier-dev/protocol";

function resolveNonEmptyEnv(raw: string | undefined, fallback: string): string {
  if (typeof raw !== "string") return fallback;
  const trimmed = raw.trim();
  return trimmed ? trimmed : fallback;
}

const DEFAULT_OPENAI_ISSUER = "https://auth.openai.com";
const DEFAULT_OPENAI_CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const DEFAULT_CLAUDE_SUBSCRIPTION_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const CLAUDE_SUBSCRIPTION_OAUTH_PROFILE_URL =
  "https://api.anthropic.com/api/oauth/profile";

export function resolveOpenAiCodexOauthClientId(env: NodeJS.ProcessEnv): string {
  return resolveNonEmptyEnv(env.HAPPIER_CONNECTED_SERVICES_OPENAI_CODEX_OAUTH_CLIENT_ID, DEFAULT_OPENAI_CODEX_CLIENT_ID);
}

export function resolveOpenAiCodexOauthTokenUrl(env: NodeJS.ProcessEnv): string {
  return resolveNonEmptyEnv(env.HAPPIER_CONNECTED_SERVICES_OPENAI_CODEX_OAUTH_TOKEN_URL, `${DEFAULT_OPENAI_ISSUER}/oauth/token`);
}

export function resolveClaudeSubscriptionOauthClientId(env: NodeJS.ProcessEnv): string {
  return resolveNonEmptyEnv(env.HAPPIER_CONNECTED_SERVICES_CLAUDE_SUBSCRIPTION_OAUTH_CLIENT_ID, DEFAULT_CLAUDE_SUBSCRIPTION_CLIENT_ID);
}

export function resolveClaudeSubscriptionOauthTokenUrl(env: NodeJS.ProcessEnv): string {
  return resolveNonEmptyEnv(env.HAPPIER_CONNECTED_SERVICES_CLAUDE_SUBSCRIPTION_OAUTH_TOKEN_URL, CLAUDE_OAUTH_TOKEN_URL);
}

export function resolveClaudeSubscriptionOauthProfileMetadata() {
  return Object.freeze({
    endpointUrl: CLAUDE_SUBSCRIPTION_OAUTH_PROFILE_URL,
    headers: Object.freeze({
      "anthropic-beta": "oauth-2025-04-20",
    }),
    projection: "claude_oauth_profile_entitlement" as const,
  });
}
