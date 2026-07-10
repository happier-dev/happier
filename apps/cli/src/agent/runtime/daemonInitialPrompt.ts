export const HAPPIER_DAEMON_INITIAL_PROMPT_ENV_KEY = 'HAPPIER_DAEMON_INITIAL_PROMPT';

export { buildDaemonInitialPromptLocalId } from '@happier-dev/protocol';

export function normalizeDaemonInitialPrompt(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function canReceiveDaemonInitialPrompt(params: Readonly<{
  metadata: unknown;
  startedByDaemonProcess: boolean;
}>): boolean {
  if (!params.startedByDaemonProcess) return false;
  if (!isRecord(params.metadata)) return false;
  return params.metadata.startedFromDaemon === true || params.metadata.startedBy === 'daemon';
}

export function consumeDaemonInitialPromptFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  const prompt = normalizeDaemonInitialPrompt(env[HAPPIER_DAEMON_INITIAL_PROMPT_ENV_KEY]);
  delete env[HAPPIER_DAEMON_INITIAL_PROMPT_ENV_KEY];
  return prompt;
}
