const LOCAL_HTTP_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

function normalizeHostname(hostname: string): string {
    const lowered = hostname.toLowerCase();
    if (lowered.startsWith('[') && lowered.endsWith(']')) {
        return lowered.slice(1, -1);
    }
    return lowered;
}

export function isSafeBadgeUrl(raw: string): boolean {
    const value = String(raw ?? '').trim();
    if (!value) return false;

    try {
        const url = new URL(value);
        if (url.protocol === 'https:') return true;
        if (url.protocol === 'http:' && LOCAL_HTTP_HOSTS.has(normalizeHostname(url.hostname))) return true;
        return false;
    } catch {
        return false;
    }
}
