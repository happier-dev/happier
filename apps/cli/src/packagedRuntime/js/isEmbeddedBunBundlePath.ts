export function isEmbeddedBunBundlePath(pathLike: string | null | undefined): boolean {
  const normalized = String(pathLike ?? '').trim().replaceAll('\\', '/');
  const lowered = normalized.toLowerCase();
  if (lowered === '/$bunfs' || lowered.startsWith('/$bunfs/')) {
    return true;
  }
  return /^(?:[a-z]:)?\/~bun(?:\/|$)/i.test(normalized);
}
