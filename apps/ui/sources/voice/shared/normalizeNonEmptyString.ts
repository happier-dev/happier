export function normalizeNonEmptyString(value: unknown): string | null {
    const trimmed = String(value ?? '').trim();
    return trimmed.length > 0 ? trimmed : null;
}
