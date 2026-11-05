export function githubRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new RangeError('Invalid GitHub object');
  return value as Readonly<Record<string, unknown>>;
}
