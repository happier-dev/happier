export function normalizeHappierRuntimePath(value: string | null | undefined): string {
  const normalized = String(value ?? '').trim().replace(/\\/gu, '/').replace(/\/+$/u, '');
  if (normalized.startsWith('/private/var/')) {
    return normalized.slice('/private'.length);
  }
  if (normalized.startsWith('/private/tmp/')) {
    return normalized.slice('/private'.length);
  }
  return normalized;
}

export function isHappierRuntimePathWithinRoot(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}
