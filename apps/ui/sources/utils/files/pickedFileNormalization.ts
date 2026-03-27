export function isBrowserFile(value: unknown): value is File {
    return typeof File !== 'undefined' && value instanceof File;
}

export function sanitizePickedName(raw: unknown, fallback: string): string {
    const value = typeof raw === 'string' ? raw : '';
    const trimmed = value.trim();
    if (!trimmed) return fallback;
    const base = trimmed.split(/[/\\]/g).pop() ?? fallback;
    const normalized = base.trim();
    return normalized || fallback;
}
