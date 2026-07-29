export function normalizeStackRuntimeOwnerStartedAt(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  const timestampMs = Date.parse(value);
  if (!Number.isFinite(timestampMs)) return null;
  const timestamp = new Date(timestampMs);
  if (!Number.isFinite(timestamp.getTime())) return null;
  const canonical = timestamp.toISOString();
  return canonical === value ? canonical : null;
}
