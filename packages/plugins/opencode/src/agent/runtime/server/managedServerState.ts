import { createHash } from 'node:crypto';

export const OPENCODE_MANAGED_SERVER_STATE_PATH_ENV_KEY = 'HAPPIER_OPENCODE_SERVER_STATE_PATH';

function readEnvString(env: NodeJS.ProcessEnv, key: string): string {
  return typeof env[key] === 'string' ? env[key] ?? '' : '';
}

function hashSecret(value: unknown): string {
  const raw = typeof value === 'string' ? value : '';
  if (!raw) return '';
  return createHash('sha256').update(raw).digest('hex');
}

export function resolveOpenCodeManagedServerStateFingerprintInput(
  env: NodeJS.ProcessEnv,
): Readonly<Record<string, string>> {
  return {
    HOME: readEnvString(env, 'HOME'),
    USERPROFILE: readEnvString(env, 'USERPROFILE'),
    HAPPIER_HOME_DIR: readEnvString(env, 'HAPPIER_HOME_DIR'),
    OPENCODE_CONFIG_CONTENT: readEnvString(env, 'OPENCODE_CONFIG_CONTENT'),
    OPENCODE_AUTH_CONTENT_SHA256: hashSecret(env.OPENCODE_AUTH_CONTENT),
    OPENAI_API_KEY: readEnvString(env, 'OPENAI_API_KEY'),
    ANTHROPIC_API_KEY: readEnvString(env, 'ANTHROPIC_API_KEY'),
  };
}

export function isOpenCodeManagedServerCommand(command: string): boolean {
  const normalized = command.toLowerCase();
  return normalized.includes('opencode') && normalized.includes('serve');
}
