/** Static Agent state-sharing declarations own the native-home environment keys. */
export function readAgentNativeHomeEnvironmentKeys(descriptor: unknown): readonly string[] {
  if (descriptor === undefined) return [];
  if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor)) {
    throw new Error('Invalid Agent state-sharing descriptor');
  }
  const value = descriptor as Readonly<Record<string, unknown>>;
  const keys: string[] = [];
  const addKey = (key: unknown) => {
    if (typeof key !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) {
      throw new Error('Invalid Agent native-home environment key');
    }
    keys.push(key);
  };
  if (value.nativeHome !== undefined) {
    if (!value.nativeHome || typeof value.nativeHome !== 'object' || Array.isArray(value.nativeHome)) {
      throw new Error('Invalid Agent native-home declaration');
    }
    addKey((value.nativeHome as Readonly<Record<string, unknown>>).environmentKey);
  }
  for (const field of ['config', 'state']) {
    const section = value[field];
    if (!section || typeof section !== 'object' || Array.isArray(section)) {
      throw new Error(`Invalid Agent state-sharing ${field} declaration`);
    }
    const entries = (section as Readonly<Record<string, unknown>>).entries;
    if (!Array.isArray(entries)) throw new Error(`Invalid Agent state-sharing ${field} entries`);
    for (const candidate of entries as readonly unknown[]) {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
        throw new Error('Invalid Agent state-sharing entry');
      }
      const entry = candidate as Readonly<Record<string, unknown>>;
      if (entry.mode === 'env_redirect' && entry.envVar) addKey(entry.envVar);
    }
  }
  return Object.freeze([...new Set(keys)].sort());
}
