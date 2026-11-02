import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';

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
