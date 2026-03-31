export function normalizeScpRemotePath(remotePath: string): string {
  const trimmed = String(remotePath ?? '').trim();
  if (!trimmed) return trimmed;
  if (trimmed.startsWith('$HOME/')) {
    return trimmed.slice('$HOME/'.length);
  }
  if (trimmed === '$HOME') {
    return '.';
  }
  return trimmed;
}

