export type ParsedTerminalConnectUrl = Readonly<{
    publicKeyB64Url: string;
    serverUrl: string | null;
}>;

const TERMINAL_PREFIX = 'happier://terminal?';
const SAFE_SERVER_PROTOCOLS = new Set(['http:', 'https:']);

function normalizeServerUrl(raw: string): string | null {
    const value = String(raw ?? '').trim();
    if (!value) return null;
    try {
        const parsed = new URL(value);
        if (!SAFE_SERVER_PROTOCOLS.has(parsed.protocol)) return null;
        return parsed.toString().replace(/\/+$/, '');
    } catch {
        return null;
    }
}

export function buildTerminalConnectDeepLink(params: Readonly<{
    publicKeyB64Url: string;
    serverUrl: string | null | undefined;
}>): string {
    const publicKeyB64Url = String(params.publicKeyB64Url ?? '').trim();
    const safeServerUrl = normalizeServerUrl(params.serverUrl ?? '');
    if (!safeServerUrl) {
        return `${TERMINAL_PREFIX}${publicKeyB64Url}`;
    }
    return `${TERMINAL_PREFIX}key=${encodeURIComponent(publicKeyB64Url)}&server=${encodeURIComponent(safeServerUrl)}`;
}

export function parseTerminalConnectUrl(url: string): ParsedTerminalConnectUrl | null {
    const raw = String(url ?? '');
    if (!raw.startsWith(TERMINAL_PREFIX)) return null;

    const tail = raw.slice(TERMINAL_PREFIX.length);
    if (!tail) return null;

    // Legacy format: happier://terminal?<publicKeyB64Url>
    // Canonical format: happier://terminal?key=<publicKeyB64Url>&server=<encodedServerUrl>
    const looksLikeQuery = tail.includes('=') || tail.includes('&');
    if (!looksLikeQuery) {
        return { publicKeyB64Url: tail, serverUrl: null };
    }

    const params = new URLSearchParams(tail);
    const key = (params.get('key') ?? '').trim();
    if (!key) return null;

    const serverUrl = normalizeServerUrl(params.get('server') ?? '');
    return { publicKeyB64Url: key, serverUrl };
}
