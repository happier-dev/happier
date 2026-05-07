export type ParsedScmRemoteUrl = Readonly<{
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
        const path = normalizeRemotePath(decodeURIComponent(parsed.pathname));
        if (!path) return null;
        return {
            host: parsed.hostname.toLowerCase(),
            path,
        };
    } catch {
        return null;
    }
}

function parseScpLikeRemote(remoteUrl: string): ParsedScmRemoteUrl | null {
    if (/^[a-zA-Z]:[\\/]/.test(remoteUrl)) return null;
    const match = /^(?:[^@\s]+@)?([^:\s]+):(.+)$/.exec(remoteUrl);
    if (!match) return null;
    const host = match[1]?.trim().toLowerCase();
    const path = normalizeRemotePath(match[2]?.trim() ?? '');
    if (!host || !path) return null;
    return { host, path };
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
