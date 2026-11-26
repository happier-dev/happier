export function normalizeScmRepoRootRelativePath(
    rawPath: string,
    pathStyle: 'posix' | 'win32'
): { ok: true; relativePath: string; pathspec: string } | { ok: false; error: string } {
    const requestedPath = String(rawPath ?? '');
    if (!requestedPath.trim()) {
        return { ok: false, error: 'Path cannot be empty' };
    }
    if (requestedPath.includes('\0')) {
        return { ok: false, error: 'Path contains null bytes' };
    }
    if (requestedPath.startsWith('-')) {
        return { ok: false, error: 'Path cannot start with "-"' };
    }
    if (requestedPath.startsWith(':')) {
        // Prevent injecting git pathspec magic like :(icase) or :(exclude)
        return { ok: false, error: 'Path contains unsupported syntax' };
    }
    if (pathStyle === 'win32' ? /^(?:[\\/]|[A-Za-z]:[\\/])/.test(requestedPath) : requestedPath.startsWith('/')) {
        return { ok: false, error: 'Absolute paths are not supported' };
    }

    const normalized = (pathStyle === 'win32' ? requestedPath.replace(/\\/g, '/') : requestedPath).replace(/^\.\/+/, '').replace(/^\/+/, '');
    const parts = normalized.split('/');
    if (parts.some((part) => part === '..')) {
        return { ok: false, error: `Path contains unsupported ".." segment: ${rawPath}` };
    }
    if (!normalized || normalized === '.') {
        return { ok: true, relativePath: '.', pathspec: ':(top).' };
    }
    return { ok: true, relativePath: normalized, pathspec: `:(top)${normalized}` };
}

function normalizeScopeToken(raw: string): string {
  const normalized = raw.replace(/\\/g, '/');
  if (!normalized) return '';
  if (normalized === '.') return '.';
  const withoutDotPrefix = normalized.replace(/^\.\//, '');
  if (!withoutDotPrefix) return '.';
  const withoutTrailingSlash = withoutDotPrefix.replace(/\/+$/, '');
  return withoutTrailingSlash || '.';
}

export function scmPathMatchesScopePath(input: {
  changedPath: string;
  scopePath: string;
}): boolean {
  const changedPath = normalizeScopeToken(input.changedPath);
  const scopePath = normalizeScopeToken(input.scopePath);
  if (!changedPath || !scopePath) return false;
  if (scopePath === '.') return true;
  return changedPath === scopePath || changedPath.startsWith(`${scopePath}/`);
}

export function resolveScmScopedChangedPaths(input: {
  changedPaths: readonly string[];
  include: readonly string[];
  exclude?: readonly string[];
}): string[] {
  const include = input.include
    .map(normalizeScopeToken)
    .filter((value) => value.length > 0);
  const exclude = (input.exclude ?? [])
    .map(normalizeScopeToken)
    .filter((value) => value.length > 0);

  if (include.length === 0) return [];

  const selected: string[] = [];
  for (const rawPath of input.changedPaths) {
    const changedPath = normalizeScopeToken(rawPath);
    if (!changedPath) continue;
    const included = include.some((scopePath) => scmPathMatchesScopePath({ changedPath, scopePath }));
    if (!included) continue;
    const excluded = exclude.some((scopePath) => scmPathMatchesScopePath({ changedPath, scopePath }));
    if (excluded) continue;
    selected.push(changedPath);
  }
  return selected;
}
