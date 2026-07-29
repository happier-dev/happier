export type StructuredToolFact = Readonly<{ label: string; value: string }>;

export function formatStructuredToolTitle(name: string): string {
    const trimmed = String(name ?? '').trim();
    if (!trimmed) return 'Tool';
    return trimmed
        .replace(/_/g, ' ')
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/\s+/g, ' ')
        .trim();
}

export function structuredToolValueToCode(value: unknown): string {
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    if (typeof value === 'string') return value;
    try {
        return JSON.stringify(value, null, 2);
    } catch {
        try {
            return String(value);
        } catch {
            return '[unprintable]';
        }
    }
}

export function normalizeStructuredToolString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

export function appendStructuredToolFact(facts: StructuredToolFact[], label: string, value: unknown): void {
    const normalized = normalizeStructuredToolString(value);
    if (normalized) facts.push({ label, value: normalized });
}

export function omitStructuredToolKnownKeys(value: unknown, knownKeys: readonly string[]): unknown | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value ?? null;
    const rest = Object.fromEntries(
        Object.entries(value as Record<string, unknown>).filter(([key]) => !knownKeys.includes(key)),
    );
    return Object.keys(rest).length > 0 ? rest : null;
}
