import { stripCliApiTokenEnvironment } from '@/auth/cliApiToken';
import { isValidProcessEnvKey } from './environmentKeys';

/** Caller-supplied environment keys, not a snapshot of every host process field. */
export type ProcessEnvInput = Readonly<Record<string, string | undefined>>;

export function normalizeUnsetEnvKeys(
  unsetEnvKeys: readonly string[] | undefined,
  platform: NodeJS.Platform = process.platform,
): readonly string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const rawName of unsetEnvKeys ?? []) {
    if (!isValidProcessEnvKey(rawName, platform)) {
      throw new Error(`Invalid environment variable unset key: ${JSON.stringify(rawName)}`);
    }
    const identity = rawName.toLowerCase();
    if (seen.has(identity)) continue;
    seen.add(identity);
    normalized.push(rawName);
  }
  return Object.freeze(normalized);
}

export function stripUnsetEnvironmentVariables(
  environment: ProcessEnvInput,
  unsetEnvKeys: readonly string[] | undefined,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const unsetNames = new Set(normalizeUnsetEnvKeys(unsetEnvKeys, platform).map((key) => key.toUpperCase()));
  const compactEnvironment: Record<string, string> = {};
  for (const [key, value] of Object.entries(environment)) {
    if (typeof value !== 'string' || unsetNames.has(key.toUpperCase())) continue;
    compactEnvironment[key] = value;
  }
  return compactEnvironment;
}

/** Merge authored values using the operating system's environment-key identity. */
export function mergeProcessEnv(params: Readonly<{
  baseEnv: ProcessEnvInput;
  explicitEnv?: ProcessEnvInput;
  platform?: NodeJS.Platform;
}>): Record<string, string | undefined> {
  const scopedEnvironment = { ...params.baseEnv };
  const explicitEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(params.explicitEnv ?? {})) {
    if (typeof value === 'string') {
      explicitEnv[key] = value;
    }
  }
  const isWindows = (params.platform ?? process.platform) === 'win32';
  for (const [key, value] of Object.entries(explicitEnv)) {
    if (isWindows) {
      const normalizedKey = key.toUpperCase();
      for (const existingKey of Object.keys(scopedEnvironment)) {
        if (existingKey.toUpperCase() === normalizedKey) {
          delete scopedEnvironment[existingKey];
        }
      }
    }
    scopedEnvironment[key] = value;
  }
  return scopedEnvironment;
}

export function buildScopedProcessEnv(params: Readonly<{
  baseEnv: ProcessEnvInput;
  explicitEnv?: ProcessEnvInput;
  unsetEnvKeys?: readonly string[];
  platform?: NodeJS.Platform;
}>): Record<string, string> {
  return stripCliApiTokenEnvironment(mergeProcessEnv({ ...params,
    baseEnv: stripUnsetEnvironmentVariables(params.baseEnv, params.unsetEnvKeys, params.platform) }));
}
