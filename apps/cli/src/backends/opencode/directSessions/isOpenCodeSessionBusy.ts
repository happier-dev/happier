export function isOpenCodeSessionBusy(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const rawType = typeof record.type === 'string' ? record.type.trim().toLowerCase() : '';
  return rawType === 'busy' || rawType === 'running';
}
