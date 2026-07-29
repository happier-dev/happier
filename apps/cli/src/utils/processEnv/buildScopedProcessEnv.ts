const ENVIRONMENT_VARIABLE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;

export function normalizeUnsetEnvKeys(
  unsetEnvKeys: readonly string[] | undefined,
): readonly string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const rawName of unsetEnvKeys ?? []) {
    if (!ENVIRONMENT_VARIABLE_NAME_PATTERN.test(rawName)) {
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
  environment: Readonly<Record<string, string | undefined>>,
  unsetEnvKeys: readonly string[] | undefined,
): Record<string, string> {
  const unsetNames = new Set(normalizeUnsetEnvKeys(unsetEnvKeys).map((key) => key.toUpperCase()));
  const compactEnvironment: Record<string, string> = {};
  for (const [key, value] of Object.entries(environment)) {
    if (typeof value !== 'string' || unsetNames.has(key.toUpperCase())) continue;
    compactEnvironment[key] = value;
  }
  return compactEnvironment;
}

export function buildScopedProcessEnv(params: Readonly<{
  baseEnv: Readonly<NodeJS.ProcessEnv>;
  explicitEnv?: Readonly<Record<string, string | undefined>>;
  unsetEnvKeys?: readonly string[];
  platform?: NodeJS.Platform;
}>): NodeJS.ProcessEnv {
  const scopedEnvironment = stripUnsetEnvironmentVariables(
    params.baseEnv,
    params.unsetEnvKeys,
  );
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
