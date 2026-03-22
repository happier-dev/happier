export type EnvOverrides = Record<string, string | undefined>;
export type EnvValues = Record<string, string | undefined>;

export function envFlag(name: string | string[], defaultValue = false): boolean {
  const names = Array.isArray(name) ? name : [name];
  for (const key of names) {
    const alt = resolveHappierHappyAlias(key);
    const raw = process.env[key] ?? (alt ? process.env[alt] : undefined);
    if (raw == null) continue;
    const v = raw.trim().toLowerCase();
    if (v === '1' || v === 'true' || v === 'yes' || v === 'y') return true;
    if (v === '0' || v === 'false' || v === 'no' || v === 'n') return false;
    // Unrecognized value; fall through to the next candidate key (or the default).
    continue;
  }
  return defaultValue;
}

export function applyEnvOverrides(overrides: EnvOverrides): () => void {
  const snapshot = snapshotEnvValues(Object.keys(overrides));
  applyEnvValues(overrides);

  return () => {
    restoreEnvValues(snapshot);
  };
}

export async function withEnvOverrides<T>(overrides: EnvOverrides, run: () => Promise<T> | T): Promise<T> {
  const restore = applyEnvOverrides(overrides);
  try {
    return await run();
  } finally {
    restore();
  }
}

export function applyEnvValues(values: EnvValues): void {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) {
      delete process.env[key];
      continue;
    }
    process.env[key] = value;
  }
}

export function snapshotEnvValues(keys: readonly string[]): EnvValues {
  const snapshot: EnvValues = {};
  for (const key of keys) {
    const value = process.env[key];
    snapshot[key] = value === undefined ? undefined : value;
  }
  return snapshot;
}

export function restoreEnvValues(snapshot: EnvValues): void {
  applyEnvValues(snapshot);
}

export function snapshotProcessEnv(): NodeJS.ProcessEnv {
  return { ...process.env };
}

export function restoreProcessEnv(snapshot: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in snapshot)) {
      delete process.env[key];
    }
  }

  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) {
      delete process.env[key];
      continue;
    }
    process.env[key] = value;
  }
}

function resolveHappierHappyAlias(name: string): string | null {
  if (name.startsWith('HAPPIER_')) return `HAPPY_${name.slice('HAPPIER_'.length)}`;
  if (name.startsWith('HAPPY_')) return `HAPPIER_${name.slice('HAPPY_'.length)}`;
  return null;
}
