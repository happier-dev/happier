const UNSAFE_PATH_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parsePath(value: unknown): readonly string[] | null {
  if (!isNonEmptyString(value) || value.length > 256) return null;
  const segments = value.split('.');
  if (segments.length === 0 || segments.length > 12) return null;
  if (segments.some((segment) => (
    !/^[A-Za-z][A-Za-z0-9_]*$/u.test(segment) || UNSAFE_PATH_SEGMENTS.has(segment)
  ))) return null;
  return Object.freeze(segments);
}

export function readRealtimeProviderConfigPath(config: Readonly<Record<string, unknown>>, path: readonly string[]): unknown {
  let current: unknown = config;
  for (const segment of path) {
    if (!isRecord(current)) return undefined;
    current = current[segment];
  }
  return current;
}

function writePath(
  current: Readonly<Record<string, unknown>>,
  path: readonly string[],
  value: unknown,
  offset: number,
): Readonly<Record<string, unknown>> {
  const segment = path[offset]!;
  if (offset === path.length - 1) return Object.freeze({ ...current, [segment]: value });
  const child = isRecord(current[segment]) ? current[segment] : {};
  return Object.freeze({ ...current, [segment]: writePath(child, path, value, offset + 1) });
}

export function updateRealtimeProviderConfig(
  owner: Readonly<{ parseConfig(value: unknown): Readonly<Record<string, unknown>> | null }>,
  config: Readonly<Record<string, unknown>>,
  path: string | readonly string[],
  value: unknown,
): Readonly<Record<string, unknown>> | null {
  const segments = typeof path === 'string' ? parsePath(path) : path;
  if (!segments || segments.length === 0 || segments.some((segment) => UNSAFE_PATH_SEGMENTS.has(segment))) return null;
  return owner.parseConfig(writePath(config, segments, value, 0));
}
