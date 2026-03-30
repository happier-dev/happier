export type OpenCodeBackendMode = 'server' | 'acp';

export function normalizeOpenCodeBackendMode(value: unknown): OpenCodeBackendMode | null {
  if (value === 'server' || value === 'acp') return value;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === 'server' || trimmed === 'acp') return trimmed;
  return null;
}
