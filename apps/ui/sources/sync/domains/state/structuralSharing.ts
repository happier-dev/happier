import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';

/**
 * The one structural-sharing owner: reconcile an incoming value against the one already published so
 * every unchanged fact, entry and array keeps its previous identity.
 *
 * Equality is JSON-shaped and key-order insensitive; an undefined member equals an omitted member
 * (transport drops it). Only plain objects and arrays are walked. Any other object (Map, Date, class
 * instance) is an opaque leaf that is retained only by identity, and own symbol members ride on the
 * incoming object untouched. Retained values are never frozen; `retainKeyedRows` publishes a frozen array unless the
 * caller's contract is a mutable one.
 */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

/**
 * Returns `previous` when `next` carries the same value, otherwise `next` with each equal nested
 * array, record and member replaced by its previous identity (at the deepest equal level).
 * `freeze` freezes every container this call rebuilds, for callers whose published values are immutable.
 */
export function retainDeep<T>(previous: T | undefined, next: T, options?: Readonly<{ freeze: true }>): T {
    if (previous === next) return next;
    if (Array.isArray(previous) && Array.isArray(next)) {
        // Items a caller already reconciled by key stay as they are; only an unmatched item is
        // compared with the previous item at its own position, and only if that one is not reused.
        const previousItems = new Set<unknown>(previous);
        const nextItems = new Set<unknown>(next);
        let samePrevious = previous.length === next.length;
        let sameNext = true;
        const items = next.map((item: unknown, index) => {
            const counterpart = previous[index];
            const retained = previousItems.has(item) || nextItems.has(counterpart) ? item : retainDeep(counterpart, item, options);
            if (retained !== counterpart) samePrevious = false;
            if (retained !== item) sameNext = false;
            return retained;
        });
        return (samePrevious ? previous : sameNext ? next : options ? Object.freeze(items) : items) as T;
    }
    if (!isPlainRecord(previous) || !isPlainRecord(next)) return next;
    const keys = Object.keys(next);
    const definedPrevious = Object.keys(previous).filter(key => previous[key] !== undefined).length;
    let samePrevious = keys.filter(key => next[key] !== undefined).length === definedPrevious;
    let sameNext = true;
    const members: Record<string, unknown> = { ...next };
    for (const key of keys) {
        const retained = retainDeep(previous[key], next[key], options);
        members[key] = retained;
        if (retained !== previous[key]) samePrevious = false;
        if (retained !== next[key]) sameNext = false;
    }
    return (samePrevious ? previous : sameNext ? next : options ? Object.freeze(members) : members) as T;
}

/** Equal complete JSON projections, regardless of object member order. */
export function areSnapshotProjectionsEquivalent(previous: unknown, incoming: unknown): boolean {
    return sameStrictJsonValue(previous, incoming, { omitUndefinedObjectMembers: true });
}

/**
 * Whole-value retention for values that are identity-bound (they carry a proof or sidecar keyed by
 * object identity): `previous` when equal, otherwise `next` untouched, never a rebuilt hybrid.
 */
export function retainIfEqual<T>(previous: T | undefined, next: T): T {
    return previous !== undefined && areSnapshotProjectionsEquivalent(previous, next) ? previous : next;
}
