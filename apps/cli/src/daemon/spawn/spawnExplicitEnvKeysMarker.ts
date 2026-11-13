import { isValidEnvVarKey } from '@/terminal/runtime/envVarSanitization';

export const HAPPIER_SPAWN_EXPLICIT_ENV_KEYS_JSON_ENV_VAR = 'HAPPIER_SPAWN_EXPLICIT_ENV_KEYS_JSON' as const;

// An empty list is an admitted carrier with no explicit keys; null has no such provenance.
export function parseExplicitSpawnEnvKeysFromProcessEnv(env: NodeJS.ProcessEnv): string[] | null {
  const raw = typeof env[HAPPIER_SPAWN_EXPLICIT_ENV_KEYS_JSON_ENV_VAR] === 'string'
    ? env[HAPPIER_SPAWN_EXPLICIT_ENV_KEYS_JSON_ENV_VAR]!.trim()
    : '';
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;
    const keys = parsed
      .filter((key): key is string => typeof key === 'string')
      .map((key) => key.trim())
      .filter(Boolean)
      .filter((key) => isValidEnvVarKey(key))
      .filter((key) => key !== HAPPIER_SPAWN_EXPLICIT_ENV_KEYS_JSON_ENV_VAR);
    return Array.from(new Set(keys));
  } catch {
    return null;
  }
}

export function resolveExplicitSpawnScopedEnvironmentFromProcessEnv(
  env: NodeJS.ProcessEnv,
): Readonly<{
  env: Readonly<Record<string, string>>;
  unsetEnvKeys?: readonly string[];
}> | undefined {
  const explicitKeys = parseExplicitSpawnEnvKeysFromProcessEnv(env);
  if (!explicitKeys?.length) return undefined;

  const scopedEnvironment: Record<string, string> = Object.create(null);
  const unsetEnvKeys: string[] = [];
  for (const key of explicitKeys) {
    const value = env[key];
    if (typeof value === 'string') {
      scopedEnvironment[key] = value;
    } else {
      unsetEnvKeys.push(key);
    }
  }

  return Object.freeze({
    env: Object.freeze(scopedEnvironment),
    ...(unsetEnvKeys.length > 0
      ? { unsetEnvKeys: Object.freeze(unsetEnvKeys) }
      : {}),
  });
}
