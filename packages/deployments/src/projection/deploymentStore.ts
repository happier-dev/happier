import type { DeploymentReadSnapshotV1 } from '../controller/deploymentReadControllerTypes.js';

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isArray(value: unknown): value is readonly unknown[] {
    return Array.isArray(value);
}

function rowKey(value: unknown): string | null {
    if (!isRecord(value)) return null;
    if (typeof value.id === 'string') return `id:${value.id}`;
    if (typeof value.serviceId === 'string') return `service:${value.serviceId}`;
    if (typeof value.machineId === 'string') return `machine:${value.machineId}`;
    if (typeof value.service === 'string' && typeof value.platform === 'string') return JSON.stringify([value.service, value.platform]);
    if (isRecord(value.targetLink)) return rowKey(value.targetLink);
    if (isRecord(value.environment)) return rowKey(value.environment);
    if (isRecord(value.domain)) return rowKey(value.domain);
    return null;
}

function isOlder(previous: unknown, incoming: unknown): boolean {
    return isRecord(previous) && isRecord(incoming) && typeof previous.id === 'string' && previous.id === incoming.id
        && typeof previous.revision === 'number' && typeof incoming.revision === 'number'
        && incoming.revision < previous.revision;
}

/** Retention happens at the producer, against its last admitted projection. */
function retain(previous: unknown, incoming: unknown): unknown {
    if (Object.is(previous, incoming) || isOlder(previous, incoming)) return previous;
    if (isArray(incoming)) {
        if (!isArray(previous)) return incoming;
        const keyed = new Map(previous.flatMap(row => {
            const key = rowKey(row);
            return key === null ? [] : [[key, row] as const];
        }));
        let equal = previous.length === incoming.length;
        const rows = incoming.map((row, index) => {
            const key = rowKey(row);
            const value = retain(key === null ? previous[index] : keyed.get(key), row);
            if (value !== previous[index]) equal = false;
            return value;
        });
        return equal ? previous : rows;
    }
    if (!isRecord(previous) || !isRecord(incoming)) return incoming;
    // An opened body belongs to its header revision. Never pair a stale body
    // with a retained newer header when a late read arrives.
    if (isOlder(previous.environment, incoming.environment) || isOlder(previous.deployment, incoming.deployment)
        || isOlder(previous.targetLink, incoming.targetLink)) return previous;
    const keys = Object.keys(incoming);
    let equal = Object.keys(previous).length === keys.length;
    const value: Record<string, unknown> = {};
    for (const key of keys) {
        value[key] = retain(previous[key], incoming[key]);
        if (value[key] !== previous[key]) equal = false;
    }
    return equal ? previous : value;
}

/** One exact resource projection; the controller owns its demand and lifetime. */
export function createDeploymentProjectionV1() {
    let snapshot: DeploymentReadSnapshotV1<unknown> = { status: 'idle', value: null, failure: null };
    const listeners = new Set<() => void>();
    return {
        getSnapshot: () => snapshot,
        subscribe(listener: () => void) {
            listeners.add(listener);
            return () => { listeners.delete(listener); };
        },
        publish(next: DeploymentReadSnapshotV1<unknown>) {
            const value = retain(snapshot, next) as DeploymentReadSnapshotV1<unknown>;
            if (value === snapshot) return;
            snapshot = value;
            for (const listener of listeners) listener();
        },
        clear() { snapshot = { status: 'idle', value: null, failure: null }; listeners.clear(); },
    };
}
