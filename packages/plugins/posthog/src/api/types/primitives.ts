/**
 * Native value readers shared by the PostHog DTO parsers.
 *
 * These are deliberately narrow: they accept the exact JSON shapes the published
 * PostHog schema declares and reject everything else, so a parser never widens a
 * provider value into a permissive `unknown` that later code has to re-guess.
 */

export function readObject(value: unknown): Readonly<Record<string, unknown>> | null {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return null;
    }
    return value as Readonly<Record<string, unknown>>;
}

export function readArray(value: unknown): readonly unknown[] | null {
    return Array.isArray(value) ? value : null;
}

export function readString(value: unknown): string | null {
    return typeof value === 'string' ? value : null;
}

/** PostHog spells many optional strings as `["string","null"]`. */
export function readNullableString(value: unknown): string | null {
    if (value === null || value === undefined) {
        return null;
    }
    return typeof value === 'string' ? value : null;
}

export function readBoolean(value: unknown): boolean | null {
    return typeof value === 'boolean' ? value : null;
}

export function readFiniteNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function readSafeInteger(value: unknown): number | null {
    return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}

const UUID_PATTERN
    = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/**
 * PostHog issue ids are UUIDs and are the source's entry identity, so a malformed one
 * is a provider-contract failure rather than a value to normalize around. The
 * lowercased form is the canonical identity spelling.
 */
export function readLowercaseUuid(value: unknown): string | null {
    if (typeof value !== 'string') {
        return null;
    }
    const lowered = value.trim().toLowerCase();
    return UUID_PATTERN.test(lowered) ? lowered : null;
}

/**
 * Reads a provider timestamp into epoch milliseconds. A missing or unparseable
 * timestamp is omitted by the caller rather than fabricated.
 */
export function readTimestampMs(value: unknown): number | null {
    if (typeof value !== 'string' || value.trim().length === 0) {
        return null;
    }
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
}
