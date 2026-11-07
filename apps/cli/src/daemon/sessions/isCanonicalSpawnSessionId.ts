export function isCanonicalSpawnSessionId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && !/^PID-\d+$/.test(value.trim());
}
