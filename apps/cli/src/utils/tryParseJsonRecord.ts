/**
 * Safely parse a JSON string and return a plain object (Record), or `null` if
 * the input is not valid JSON or does not represent a plain object (arrays and
 * primitives are rejected).
 */
export function tryParseJsonRecord(value: string): Record<string, unknown> | null {
    try {
        const parsed = JSON.parse(value);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
        return parsed as Record<string, unknown>;
    } catch {
        return null;
    }
}

/** Alias for {@link tryParseJsonRecord} kept for backward compatibility. */
export const tryParseJsonObject = tryParseJsonRecord;
