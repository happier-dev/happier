export function normalizeWorkspaceRelativeMediaPath(value: string): string | null {
  const normalized = value.replace(/[\\]+/g, '/').replace(/^\/+|\/+$/g, '');
  if (!normalized || normalized.startsWith('/') || normalized.includes('\0')) return null;
  if (normalized.split('/').some((segment) => segment === '.' || segment === '..')) return null;
  return normalized;
}
