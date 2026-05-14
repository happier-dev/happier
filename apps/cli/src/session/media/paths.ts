export function normalizePathSegment(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed === '.' || trimmed === '..') return null;
  if (trimmed.includes('\0')) return null;
  if (trimmed.includes('/') || trimmed.includes('\\')) return null;
  return trimmed;
}

export function joinSessionMediaPath(...segments: readonly string[]): string {
  return segments
    .map((segment) => segment.replace(/[\\]+/g, '/').replace(/^\/+|\/+$/g, ''))
    .filter((segment) => segment.length > 0)
    .join('/');
}

export function normalizeWorkspaceRelativeMediaPath(value: string): string | null {
  const normalized = joinSessionMediaPath(value);
  if (!normalized || normalized.startsWith('/') || normalized.includes('\0')) return null;
  if (normalized.split('/').some((segment) => segment === '.' || segment === '..')) return null;
  return normalized;
}
