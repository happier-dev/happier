function resolveNonEmptyEnv(raw: string | undefined, fallback: string): string {
  if (typeof raw !== 'string') return fallback;
  const trimmed = raw.trim();
  return trimmed ? trimmed : fallback;
}

const DEFAULT_OPENAI_CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const DEFAULT_OPENAI_CODEX_TOKEN_URL = 'https://auth.openai.com/oauth/token';

const DEFAULT_CLAUDE_SUBSCRIPTION_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const DEFAULT_CLAUDE_SUBSCRIPTION_TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token';

const DEFAULT_GEMINI_CLIENT_ID = '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com';
const DEFAULT_GEMINI_CLIENT_SECRET = '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l';
const DEFAULT_GEMINI_TOKEN_URL = 'https://oauth2.googleapis.com/token';

export function resolveOpenAiCodexOauthClientId(env: NodeJS.ProcessEnv): string {
  return resolveNonEmptyEnv(env.HAPPIER_CONNECTED_SERVICES_OPENAI_CODEX_OAUTH_CLIENT_ID, DEFAULT_OPENAI_CODEX_CLIENT_ID);
}

export function resolveOpenAiCodexOauthTokenUrl(env: NodeJS.ProcessEnv): string {
  return resolveNonEmptyEnv(env.HAPPIER_CONNECTED_SERVICES_OPENAI_CODEX_OAUTH_TOKEN_URL, DEFAULT_OPENAI_CODEX_TOKEN_URL);
}

export function resolveClaudeSubscriptionOauthClientId(env: NodeJS.ProcessEnv): string {
  return resolveNonEmptyEnv(env.HAPPIER_CONNECTED_SERVICES_CLAUDE_SUBSCRIPTION_OAUTH_CLIENT_ID, DEFAULT_CLAUDE_SUBSCRIPTION_CLIENT_ID);
}

export function resolveClaudeSubscriptionOauthTokenUrl(env: NodeJS.ProcessEnv): string {
  return resolveNonEmptyEnv(env.HAPPIER_CONNECTED_SERVICES_CLAUDE_SUBSCRIPTION_OAUTH_TOKEN_URL, DEFAULT_CLAUDE_SUBSCRIPTION_TOKEN_URL);
}

export function resolveGeminiOauthClientId(env: NodeJS.ProcessEnv): string {
  return resolveNonEmptyEnv(env.HAPPIER_CONNECTED_SERVICES_GEMINI_OAUTH_CLIENT_ID, DEFAULT_GEMINI_CLIENT_ID);
}

export function resolveGeminiOauthClientSecret(env: NodeJS.ProcessEnv): string {
  return resolveNonEmptyEnv(env.HAPPIER_CONNECTED_SERVICES_GEMINI_OAUTH_CLIENT_SECRET, DEFAULT_GEMINI_CLIENT_SECRET);
}

export function resolveGeminiOauthTokenUrl(env: NodeJS.ProcessEnv): string {
  return resolveNonEmptyEnv(env.HAPPIER_CONNECTED_SERVICES_GEMINI_OAUTH_TOKEN_URL, DEFAULT_GEMINI_TOKEN_URL);
}
