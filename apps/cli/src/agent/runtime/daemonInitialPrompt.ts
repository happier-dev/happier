export const HAPPIER_DAEMON_INITIAL_PROMPT_ENV_KEY = 'HAPPIER_DAEMON_INITIAL_PROMPT';

export function normalizeDaemonInitialPrompt(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

export function consumeDaemonInitialPromptFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  const prompt = normalizeDaemonInitialPrompt(env[HAPPIER_DAEMON_INITIAL_PROMPT_ENV_KEY]);
  delete env[HAPPIER_DAEMON_INITIAL_PROMPT_ENV_KEY];
  return prompt;
}

