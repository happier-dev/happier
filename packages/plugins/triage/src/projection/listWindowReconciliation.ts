import type { ProjectedObservationV1 } from '../corpus/fold/projectedObservation.js';

/** Structural sharing at the retained projection ingress, over already admitted JSON values. */
export function retainTriageProjectionValue<T>(previous: T | undefined, next: T): T {
    return retainValue(previous, next) as T;
}

function retainValue(previous: unknown, next: unknown): unknown {
    if (previous === next) return previous;
    if (Array.isArray(next)) {
        if (!Array.isArray(previous)) return next;
        const oldValues: readonly unknown[] = previous;
        const incomingValues: readonly unknown[] = next;
        // Row facts carry their own domain id. A reorder must keep each fact, not compare it
        // against whichever different fact happened to occupy that position before.
        const byId = new Map(oldValues.flatMap(value => {
            const id: unknown = value !== null && typeof value === 'object' ? Reflect.get(value, 'id') : undefined;
            return typeof id === 'string' ? [[id, value] as const] : [];
        }));
        let changed = oldValues.length !== incomingValues.length;
        let shared = false;
        const values = incomingValues.map((value, index) => {
            const id: unknown = value !== null && typeof value === 'object' ? Reflect.get(value, 'id') : undefined;
            const retained = retainValue(typeof id === 'string' ? byId.get(id) : oldValues[index], value);
            if (retained !== oldValues[index]) changed = true;
            if (retained !== value) shared = true;
            return retained;
        });
        if (!changed) return previous;
        return shared ? Object.freeze(values) : next;
    }
    if (next === null || typeof next !== 'object' || previous === null || typeof previous !== 'object'
        || Array.isArray(previous)) return next;
    const old = previous as Readonly<Record<string, unknown>>;
    const incoming = next as Readonly<Record<string, unknown>>;
    const keys = Object.keys(incoming);
    let changed = Object.keys(old).length !== keys.length;
    let shared = false;
    const value: Record<string, unknown> = {};
    for (const key of keys) {
        const retained = retainValue(old[key], incoming[key]);
        Object.defineProperty(value, key, { value: retained, enumerable: true });
        if (!Object.hasOwn(old, key) || retained !== old[key]) changed = true;
        if (retained !== incoming[key]) shared = true;
    }
    if (!changed) return previous;
    return shared ? Object.freeze(value) : next;
}

/** Keep the current read clock while sharing equal admitted outcomes and their nested facts. */
export function retainTriageObservation<T extends ProjectedObservationV1>(previous: T | undefined, next: T): T {
    if (previous === undefined || previous.sourceInstanceId !== next.sourceInstanceId) return next;
    const outcome = retainTriageProjectionValue(previous.outcome, next.outcome);
    if (outcome === previous.outcome && next.observedAtMs === previous.observedAtMs) return previous;
    return outcome === next.outcome ? next : { ...next, outcome };
}

/**
 * A successful equal recheck advances store freshness, not a row's last semantic observation.
 * Keep real clocks for unresolved/absent answers and the observation-time ordering fallback.
 * Connection-answer winner selection has already used the current clocks before this step.
 */
export function retainTriageRowObservation(
    previous: ProjectedObservationV1 | undefined,
    next: ProjectedObservationV1,
): ProjectedObservationV1 {
    const retained = retainTriageObservation(previous, next);
    if (previous !== undefined && retained.outcome === previous.outcome && retained.outcome.kind === 'present'
        && (retained.outcome.sourceUpdatedAtMs !== undefined || retained.outcome.snapshot.createdAtMs !== undefined)) {
        return previous;
    }
    return retained;
}

export function retainTriageProjectionArray<T>(previous: readonly T[] | undefined, next: readonly T[]): readonly T[] {
    return previous !== undefined && previous.length === next.length
        && next.every((value, index) => value === previous[index]) ? previous : Object.freeze(next);
}
