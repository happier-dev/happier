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
  const normalizedPath = normalizeHappierRuntimePath(path);
  const normalizedRoot = normalizeHappierRuntimePath(root);
  if (!normalizedPath || !normalizedRoot) {
    return false;
  }

  const windowsPath = /^[a-z]:\//iu.test(normalizedPath) || normalizedPath.startsWith('//');
  const windowsRoot = /^[a-z]:\//iu.test(normalizedRoot) || normalizedRoot.startsWith('//');
  const comparablePath = windowsPath && windowsRoot ? normalizedPath.toLowerCase() : normalizedPath;
  const comparableRoot = windowsPath && windowsRoot ? normalizedRoot.toLowerCase() : normalizedRoot;
  return comparablePath === comparableRoot || comparablePath.startsWith(`${comparableRoot}/`);
}
