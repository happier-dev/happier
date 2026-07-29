export function readPortableNpmPackageFiles(value: unknown): readonly string[] {
  if (!Array.isArray(value)
    || value.length === 0
    || !value.every((selectedPath) => typeof selectedPath === 'string')) {
    throw new Error('package.json files must be a non-empty deliberate file inventory');
  }

  const normalized = value.map((selectedPath) => {
    const raw = selectedPath.trim().replace(/^\.\//u, '').replace(/\/$/u, '');
    const normalizedPath = raw.endsWith('/**') ? raw.slice(0, -3) : raw;
    if (!normalizedPath
      || normalizedPath.startsWith('/')
      || /^[A-Za-z]:/u.test(normalizedPath)
      || normalizedPath.includes('\\')
      || normalizedPath.includes('\u0000')
      || /[*?\[\]{}!]/u.test(normalizedPath)) {
      throw new Error(
        `package.json files entry is not a supported portable file or directory: ${JSON.stringify(selectedPath)}`,
      );
    }
    const segments = normalizedPath.split('/');
    if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
      throw new Error(
        `package.json files entry must not traverse or contain empty segments: ${JSON.stringify(selectedPath)}`,
      );
    }
    return normalizedPath;
  });

  return Object.freeze([...new Set(normalized)]);
}
