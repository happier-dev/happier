export function sanitizeUrlForLog(raw: string): string {
    const trimmed = String(raw ?? '').trim();
    if (!trimmed) return '';
    try {
        const url = new URL(trimmed);
        url.username = '';
        url.password = '';
        url.search = '';
        url.hash = '';
        return url.toString().replace(/\/+$/, '');
    } catch {
        if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
            return trimmed;
        }

        // Fallback sanitization for URL-like strings that fail `new URL(...)` parsing.
        let next = trimmed;
        const schemeIndex = next.indexOf('://');
        if (schemeIndex >= 0) {
            const authorityStart = schemeIndex + 3;
            const firstSlash = next.indexOf('/', authorityStart);
            const firstQuery = next.indexOf('?', authorityStart);
            const firstHash = next.indexOf('#', authorityStart);
            const authorityEnd = [firstSlash, firstQuery, firstHash]
                .filter((v) => v >= 0)
                .reduce((min, v) => Math.min(min, v), Number.POSITIVE_INFINITY);
            const end = authorityEnd === Number.POSITIVE_INFINITY ? next.length : authorityEnd;
            const at = next.indexOf('@', authorityStart);
            if (at >= 0 && at < end) {
                next = `${next.slice(0, authorityStart)}${next.slice(at + 1)}`;
            }
        }

        const q = next.indexOf('?');
        const h = next.indexOf('#');
        const cut = [q, h].filter((v) => v >= 0).reduce((min, v) => Math.min(min, v), Number.POSITIVE_INFINITY);
        if (cut !== Number.POSITIVE_INFINITY) {
            next = next.slice(0, cut);
        }

        return next.replace(/\/+$/, '');
    }
}
