function normalizeLoopbackHost(rawHost: string): string {
    const host = String(rawHost ?? '').trim().toLowerCase();
    if (host === '127.0.0.1' || host === '::1' || host === '[::1]') return 'localhost';
    return host;
}

export function canonicalizeServerUrl(raw: string): string {
    const value = String(raw ?? '').trim();
    if (!value) return '';
    const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value);
    try {
        const parsed = new URL(hasScheme ? value : `https://${value}`);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
        parsed.search = '';
        parsed.hash = '';
        return parsed.toString().replace(/\/+$/, '');
    } catch {
        return '';
    }
}

export function createServerUrlComparableKey(raw: string): string {
    const canonical = canonicalizeServerUrl(raw);
    if (!canonical) return '';
    try {
        const parsed = new URL(canonical);
        const protocol = parsed.protocol.toLowerCase();
        const host = normalizeLoopbackHost(parsed.hostname);
        const explicitPort = parsed.port;
        const port = (() => {
            if (!explicitPort) return '';
            if (protocol === 'https:' && explicitPort === '443') return '';
            if (protocol === 'http:' && explicitPort === '80') return '';
            return `:${explicitPort}`;
        })();
        const path = parsed.pathname.replace(/\/+$/, '');
        return `${protocol}//${host}${port}${path}`;
    } catch {
        return canonical.toLowerCase();
    }
}
