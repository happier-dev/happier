export function asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
}

export function firstNonEmptyString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

export function hasNonEmptyRecord(value: unknown): boolean {
    const record = asRecord(value);
    return !!record && Object.keys(record).length > 0;
}

