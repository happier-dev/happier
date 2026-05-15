/**
 * Hardened SCM remote URL parser shared across first-party SCM hosting provider plugins.
 *
 * Rejects URL shapes that should never appear in a valid `origin`/`upstream` remote:
 * - port number (e.g. `https://host:8443/owner/repo`) — would silently be stripped from `host`
 *   and could be used to point downstream HTTP calls at an attacker-controlled origin
 *   if the consumer ever reconstructs the URL
 * - search params or hash fragments — never valid for a Git remote
 * - embedded password (any scheme) — credential should come from the descriptor materializer
 * - embedded username on `https:` — same reason; SSH allows `git@host` so username on `ssh:`/`scp:` is preserved
 *
 * The parser returns a normalized `{ scheme, host, path }` shape where:
 * - `scheme` is the locked enum `'https:' | 'ssh:' | 'scp:'`
 * - `host` is lowercased (hostnames are case-insensitive per RFC 3986)
 * - `path` has the leading/trailing slashes trimmed and `.git` suffix stripped
 *
 * Behavior is intentionally conservative: ambiguous or non-canonical URLs return `null` so the
 * adapter can fall back to other detection paths instead of inheriting a half-parsed shape.
 */
export type ScmRemoteUrlScheme = 'https:' | 'ssh:' | 'scp:';

export type ParsedScmRemoteUrl = Readonly<{
    scheme: ScmRemoteUrlScheme;
    host: string;
    path: string;
}>;

function stripGitSuffix(path: string): string {
    return path.endsWith('.git') ? path.slice(0, -4) : path;
}

function normalizeRemotePath(path: string): string {
    return stripGitSuffix(path.replace(/^\/+/, '').replace(/\/+$/, ''));
}

type UrlLikeParseOutcome =
    | { kind: 'success'; parsed: ParsedScmRemoteUrl }
    | { kind: 'rejected' }
    | { kind: 'not-url' };

function parseUrlLikeRemote(remoteUrl: string): UrlLikeParseOutcome {
    let parsed: URL;
    try {
        parsed = new URL(remoteUrl);
    } catch {
        // The string isn't URL-shaped at all; let the scp-like branch try.
        return { kind: 'not-url' };
    }
    // From here on the string was a parseable URL. Any policy failure must reject the
    // whole input — falling back to scp-style parsing would let an attacker bypass the
    // policy by appending `://` shenanigans (e.g. https://host:8443 → scp(host='https')).
    if (!parsed.hostname || !parsed.pathname) return { kind: 'rejected' };
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'ssh:') return { kind: 'rejected' };
    // Defense-in-depth: port/search/hash should never appear on a git remote.
    if (parsed.port || parsed.search || parsed.hash) return { kind: 'rejected' };
    // Embedded credentials must come from the descriptor materializer, never the URL.
    if (parsed.password) return { kind: 'rejected' };
    if (parsed.protocol === 'https:' && parsed.username) return { kind: 'rejected' };
    const path = normalizeRemotePath(decodeURIComponent(parsed.pathname));
    if (path.includes('?') || path.includes('#')) return { kind: 'rejected' };
    if (!path) return { kind: 'rejected' };
    return {
        kind: 'success',
        parsed: {
            scheme: parsed.protocol,
            host: parsed.hostname.toLowerCase(),
            path,
        },
    };
}

function parseScpLikeRemote(remoteUrl: string): ParsedScmRemoteUrl | null {
    // Avoid Windows drive letters like "C:/foo"
    if (/^[a-zA-Z]:[\\/]/.test(remoteUrl)) return null;
    const match = /^(?:[^@\s]+@)?([^:\s]+):(.+)$/.exec(remoteUrl);
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
    const urlOutcome = parseUrlLikeRemote(trimmed);
    if (urlOutcome.kind === 'success') return urlOutcome.parsed;
    if (urlOutcome.kind === 'rejected') return null;
    return parseScpLikeRemote(trimmed);
}

export function encodeCompareRef(ref: string): string {
    return encodeURIComponent(ref);
}

export function stripTrailingSlash(value: string): string {
    return value.replace(/\/+$/, '');
}
