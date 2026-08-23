/**
 * The one structural rule every Triage Account Settings parser applies before
 * it looks at a single member.
 *
 * A stored value carrying a key this build does not know belongs to a newer
 * writer. Every Triage settings owner refuses it whole rather than reading the
 * members it recognizes, because a partial read is exactly how the next
 * ordinary write destroys durable user state another client can still read. It
 * lives here so the two owners cannot drift into two different ideas of "a
 * shape this build understands".
 */
export function readExactKeys(
    value: unknown,
    keys: readonly string[],
): Readonly<Record<string, unknown>> | null {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const candidate = value as Readonly<Record<string, unknown>>;
    const present = Object.keys(candidate);
    if (present.length !== keys.length) return null;
    return present.every((key) => keys.includes(key)) ? candidate : null;
}
