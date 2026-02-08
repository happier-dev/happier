const LOCAL_HTTP_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
const ALLOWED_PROTOCOLS = new Set(['https:', 'happier:']);

function normalizeHost(hostname: string): string {
    const value = String(hostname ?? '').trim().toLowerCase();
    if (value.startsWith('[') && value.endsWith(']')) return value.slice(1, -1);
    return value;
}

export function isSafeExternalAuthUrl(raw: string): boolean {
    const value = String(raw ?? '').trim();
    if (!value) return false;
    try {
        const url = new URL(value);
        if (ALLOWED_PROTOCOLS.has(url.protocol)) return true;
        if (url.protocol === 'http:' && LOCAL_HTTP_HOSTS.has(normalizeHost(url.hostname))) return true;
        return false;
    } catch {
        return false;
    }
}
