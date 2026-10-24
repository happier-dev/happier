/**
 * Paths that are never scanned for symbols or sent to an analysis model: dependency trees, build
 * output, lockfiles, and common secret-bearing files, plus the user's configured prefixes.
 */
const DEFAULT_EXCLUDED_SEGMENTS = new Set([
  'node_modules',
  'vendor',
  'dist',
  'build',
  'target',
  '.next',
  '.venv',
  'venv',
  '__pycache__',
  'Pods',
]);

const SECRET_OR_GENERATED_FILE = /(^|\/)(\.env(\..*)?|.*\.pem|.*\.key|id_rsa.*|.*\.p12|.*\.pfx|yarn\.lock|package-lock\.json|pnpm-lock\.yaml|Cargo\.lock|go\.sum|.*\.min\.(js|css))$/is;

// A configured entry is a repository-relative path prefix; `*` (within one segment), `**` (across
// segments) and `?` make it a glob matched against the start of the path, so `**/secrets/` excludes
// every `secrets` directory.
function compileConfiguredExclusion(entry: string): RegExp | null {
  const clean = entry.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!clean) return null;
  let pattern = '';
  for (let index = 0; index < clean.length; index += 1) {
    const char = clean[index]!;
    if (char === '*' && clean[index + 1] === '*') {
      const followedBySlash = clean[index + 2] === '/';
      pattern += followedBySlash ? '(?:.*/)?' : '.*';
      index += followedBySlash ? 2 : 1;
    } else if (char === '*') {
      pattern += '[^/]*';
    } else if (char === '?') {
      pattern += '[^/]';
    } else {
      pattern += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  // Prefix semantics, like a plain entry: erring towards excluding more is the safe direction.
  // `s`: a path component may contain a line break, which must not end a `**` match.
  return new RegExp(`^${pattern}`, 's');
}

/** A changed file is excluded when either side of a rename or copy is. */
export function isChangedFileExcluded(
  file: Readonly<{ path: string; previousPath: string | null }>,
  configuredPrefixes: readonly string[],
): boolean {
  return isPathExcludedFromIntelligence(file.path, configuredPrefixes)
    || (file.previousPath !== null && isPathExcludedFromIntelligence(file.previousPath, configuredPrefixes));
}

export function isPathExcludedFromIntelligence(path: string, configuredPrefixes: readonly string[]): boolean {
  const normalized = path.replace(/\\/g, '/');
  if (normalized.split('/').some((segment) => DEFAULT_EXCLUDED_SEGMENTS.has(segment))) return true;
  if (SECRET_OR_GENERATED_FILE.test(normalized)) return true;
  return configuredPrefixes.some((entry) => compileConfiguredExclusion(entry)?.test(normalized) ?? false);
}
