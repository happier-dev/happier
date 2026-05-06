export type ParsedScmRemoteUrl = Readonly<{
  scheme: 'https:' | 'ssh:' | 'scp:';
  host: string;
  path: string;
}>;

function stripGitSuffix(path: string): string {
  return path.endsWith('.git') ? path.slice(0, -4) : path;
}

function normalizeRemotePath(path: string): string {
  return stripGitSuffix(path.replace(/^\/+/, '').replace(/\/+$/, ''));
}

function parseUrlLikeRemote(remoteUrl: string): ParsedScmRemoteUrl | null {
  try {
    const parsed = new URL(remoteUrl);
    if (!parsed.hostname || !parsed.pathname) return null;
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'ssh:') return null;
    if (parsed.port || parsed.search || parsed.hash) return null;
    if (parsed.password) return null;
    if (parsed.protocol === 'https:' && parsed.username) return null;
    const path = normalizeRemotePath(decodeURIComponent(parsed.pathname));
    if (path.includes('?') || path.includes('#')) return null;
    if (!path) return null;
    return {
      scheme: parsed.protocol,
      host: parsed.hostname.toLowerCase(),
      path,
    };
  } catch {
    return null;
  }
}

function parseScpLikeRemote(remoteUrl: string): ParsedScmRemoteUrl | null {
  if (/^[a-zA-Z]:[\\/]/.test(remoteUrl)) return null;
  const match = remoteUrl.match(/^(?:[^@\s]+@)?([^:\s]+):(.+)$/);
  if (!match) return null;
  const host = match[1]?.trim().toLowerCase();
  const path = normalizeRemotePath(match[2]?.trim() ?? '');
  if (path.includes('?') || path.includes('#')) return null;
  if (!host || !path) return null;
  return { scheme: 'scp:', host, path };
}

export function parseScmRemoteUrl(remoteUrl: string): ParsedScmRemoteUrl | null {
  const trimmed = remoteUrl.trim();
  if (!trimmed) return null;
  return parseUrlLikeRemote(trimmed) ?? parseScpLikeRemote(trimmed);
}

export function encodeCompareRef(ref: string): string {
  return encodeURIComponent(ref);
}

export function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}
