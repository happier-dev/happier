export function isEmbeddedBunBundlePath(pathLike: string | null | undefined): boolean {
  const normalized = String(pathLike ?? '').trim().replaceAll('\\', '/');
  return normalized === '/$bunfs' || normalized.startsWith('/$bunfs/');
}
