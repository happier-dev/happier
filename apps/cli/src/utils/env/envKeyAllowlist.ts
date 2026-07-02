export function createAllowedEnvKeySet(
  keys: readonly string[],
  platform: NodeJS.Platform = process.platform,
): ReadonlySet<string> {
  if (platform !== 'win32') return new Set(keys);
  return new Set(keys.map((key) => key.toLowerCase()));
}

export function isAllowedEnvKey(
  key: string,
  allowedKeys: ReadonlySet<string>,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return allowedKeys.has(platform === 'win32' ? key.toLowerCase() : key);
}
