import { isValidEnvVarKey } from '@/terminal/runtime/envVarSanitization';

export const HAPPIER_SPAWN_EXPLICIT_ENV_KEYS_JSON_ENV_VAR = 'HAPPIER_SPAWN_EXPLICIT_ENV_KEYS_JSON' as const;

export function parseExplicitSpawnEnvKeysFromProcessEnv(env: NodeJS.ProcessEnv): string[] {
  const raw = typeof env[HAPPIER_SPAWN_EXPLICIT_ENV_KEYS_JSON_ENV_VAR] === 'string'
    ? env[HAPPIER_SPAWN_EXPLICIT_ENV_KEYS_JSON_ENV_VAR]!.trim()
    : '';
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const keys = parsed
      .filter((key): key is string => typeof key === 'string')
      .map((key) => key.trim())
      .filter(Boolean)
      .filter((key) => isValidEnvVarKey(key))
      .filter((key) => key !== HAPPIER_SPAWN_EXPLICIT_ENV_KEYS_JSON_ENV_VAR);
    return Array.from(new Set(keys));
  } catch {
    return [];
  }
}
