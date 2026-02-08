export function coerceRelativeRoute(raw: string): string | null {
    const trimmed = raw.trim();
    if (!trimmed) return null;

    let decoded: string;
    try {
        decoded = decodeURIComponent(trimmed);
    } catch {
        return null;
    }

    if (decoded.includes('\\')) return null;
    if (decoded.includes(':')) return null;
    if (!decoded.startsWith('/')) return null;
    if (decoded.startsWith('//')) return null;
    if (decoded.includes('//')) return null;

    return decoded;
}
