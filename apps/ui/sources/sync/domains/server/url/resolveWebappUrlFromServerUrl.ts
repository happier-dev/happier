export function resolveWebappUrlFromServerUrl(serverUrl: string): string {
    const normalized = String(serverUrl ?? '').trim();
    if (!normalized) return normalized;

    try {
        const parsed = new URL(normalized);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            return normalized;
        }
        const origin = parsed.origin.replace(/\/+$/, '');
        if (origin === 'https://api.happier.dev') {
            return 'https://app.happier.dev';
        }
        return origin;
    } catch {
        return normalized;
    }
}

