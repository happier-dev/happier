function decodePathLike(pathLike: string): string {
  try {
    return decodeURI(pathLike);
  } catch {
    return pathLike;
  }
}

export function isEmbeddedBunBundlePath(pathLike: string | null | undefined): boolean {
  const normalized = decodePathLike(String(pathLike ?? '').trim()).replaceAll('\\', '/');
  const normalizedWindowsUrlPath = normalized.replace(/^\/([a-z]:\/)/i, '$1');
  for (const candidate of [normalized, normalizedWindowsUrlPath]) {
    const lowered = candidate.toLowerCase();
    if (lowered === '/$bunfs' || lowered.startsWith('/$bunfs/')) {
      return true;
    }
    if (/^(?:[a-z]:)?\/~bun(?:\/|$)/i.test(candidate)) {
      return true;
    }
  }
  return false;
}
