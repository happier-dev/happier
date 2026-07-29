function normalizeScopeToken(raw: string): string {
  const trimmed = raw.trim().replace(/\\/g, '/');
  if (!trimmed) return '';
  if (trimmed === '.') return '.';
  const withoutDotPrefix = trimmed.replace(/^\.\//, '');
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
