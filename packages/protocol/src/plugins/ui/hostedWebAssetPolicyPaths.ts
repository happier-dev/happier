export type HostedWebAssetNormalizedRequestPath =
  | Readonly<{ ok: true; path: string; directoryRequest: boolean }>
  | Readonly<{ ok: false }>;

function trimArtifactPath(path: string): string {
  return path.trim().replace(/^\/+|\/+$/gu, '');
}

/**
 * Artifact paths are protocol identifiers, never host filesystem paths. Keep
 * Windows drive/UNC spellings out at this boundary so neither a browser URL
 * decoder nor a native file handler can reinterpret them later.
 */
function hasWindowsPathSyntax(path: string): boolean {
  return path.includes('\\')
    || /^(?:\/{2,}|\\\\)/u.test(path)
    || /(?:^|\/)[A-Za-z]:/u.test(path);
}

/**
 * A percent-encoded separator or dot segment changes the path grammar after
 * decoding. The canonical policy deliberately accepts already-normalized
 * in-root `a/../b` compatibility paths, but never lets an encoded spelling
 * smuggle that traversal through a URL/native-handler boundary.
 */
function hasEncodedTraversalOrSeparator(rawPath: string): boolean {
  for (const rawSegment of rawPath.split('/')) {
    if (!rawSegment.includes('%')) continue;
    let decodedSegment: string;
    try {
      decodedSegment = decodeURIComponent(rawSegment);
    } catch {
      return true;
    }
    if (
      decodedSegment === '.'
      || decodedSegment === '..'
      || decodedSegment.includes('/')
      || decodedSegment.includes('\\')
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Canonical artifact-path normalization shared by the pure policy and its
 * native table serializer. It is intentionally not a filesystem resolver.
 */
export function normalizeHostedWebAssetArtifactPath(path: string): string | null {
  if (path.includes('\0') || hasWindowsPathSyntax(path)) {
    return null;
  }
  const trimmed = trimArtifactPath(path);
  if (trimmed.length === 0) {
    return null;
  }

  const segments: string[] = [];
  for (const segment of trimmed.split('/')) {
    if (segment.length === 0 || segment === '.') {
      continue;
    }
    if (segment === '..') {
      if (segments.length === 0) {
        return null;
      }
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.length > 0 ? segments.join('/') : null;
}

/**
 * Decodes and normalizes a URL request path before the policy decides whether
 * it is an admitted artifact route. Native adapters consume this same rule
 * through the serialized table's reference interpreter/conformance vectors.
 */
export function normalizeHostedWebAssetRequestPath(
  requestPath: string,
): HostedWebAssetNormalizedRequestPath {
  const rawPath = requestPath.split('?')[0] ?? requestPath;
  if (hasEncodedTraversalOrSeparator(rawPath)) {
    return { ok: false };
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return { ok: false };
  }
  if (decoded.includes('\0') || hasWindowsPathSyntax(decoded)) {
    return { ok: false };
  }
  const directoryRequest = decoded.endsWith('/');
  const trimmed = decoded.replace(/^\/+/u, '');
  if (trimmed.length === 0) {
    return { ok: true, path: '', directoryRequest: false };
  }
  const normalized = normalizeHostedWebAssetArtifactPath(trimmed);
  return normalized === null ? { ok: false } : { ok: true, path: normalized, directoryRequest };
}

export function hasHostedWebAssetFileExtension(path: string): boolean {
  const basename = path.slice(path.lastIndexOf('/') + 1);
  const lastDot = basename.lastIndexOf('.');
  return lastDot > 0;
}

export function isWithinHostedWebAssetRoot(assetRootId: string, path: string): boolean {
  return path === assetRootId || path.startsWith(`${assetRootId}/`);
}
