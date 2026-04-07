export function normalizeHappierRuntimePath(value: string | null | undefined): string {
  return String(value ?? '').trim().replace(/\\/gu, '/').replace(/\/+$/u, '');
}

export function isHappierRuntimePathWithinRoot(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}
