import { PROJECT_FINITE_ACTION_RPC_METHODS_V1 } from '@happier-dev/protocol/actions/projectActionIdsV1';
import type { QualifiedActionOperation } from './qualifiedActionOperation';
import { serverAccountScopedResourceKey, type ServerAccountScope } from '../scope/serverAccountScope';

function statusKey(operation: QualifiedActionOperation | undefined): string | null {
    return operation && Object.hasOwn(PROJECT_FINITE_ACTION_RPC_METHODS_V1, operation.snapshot.actionId)
        ? serverAccountScopedResourceKey({ serverId: operation.serverId, accountId: operation.snapshot.scope.accountId }, operation.snapshot.scope.machineId)
        : null;
}

function preparing(operation: QualifiedActionOperation | undefined): boolean {
    return operation?.snapshot.progress?.kind === 'phase' && operation.snapshot.progress.phase === 'preparing';
}

type WorkerStatusChanges = Readonly<{
    read(scope: ServerAccountScope, machineId: string): number;
    subscribe(scope: ServerAccountScope, machineIds: readonly string[], listener: () => void): () => void;
    publish(previous: ReadonlyMap<string, QualifiedActionOperation>, next: ReadonlyMap<string, QualifiedActionOperation>, changedKeys: Iterable<string>): void;
}>;

/** Producer-owned exact Machine invalidations; labels/revisions alone are not load facts. */
export function createWorkerStatusChanges(): WorkerStatusChanges {
    const revisions = new Map<string, number>();
    const listeners = new Map<string, Set<() => void>>();
    return {
        read(scope: ServerAccountScope, machineId: string): number {
            return revisions.get(serverAccountScopedResourceKey(scope, machineId)) ?? 0;
        },
        subscribe(scope: ServerAccountScope, machineIds: readonly string[], listener: () => void): () => void {
            const keys = machineIds.map(id => serverAccountScopedResourceKey(scope, id));
            for (const key of keys) {
                const current = listeners.get(key) ?? new Set<() => void>();
                current.add(listener);
                listeners.set(key, current);
            }
            return () => {
                for (const key of keys) {
                    const current = listeners.get(key);
                    current?.delete(listener);
                    if (current?.size === 0) listeners.delete(key);
                }
            };
        },
        publish(previous: ReadonlyMap<string, QualifiedActionOperation>, next: ReadonlyMap<string, QualifiedActionOperation>, changedKeys: Iterable<string>): void {
            const affected = new Set<string>();
            for (const key of changedKeys) {
                const before = previous.get(key);
                const after = next.get(key);
                const beforeKey = statusKey(before);
                const afterKey = statusKey(after);
                if (beforeKey === afterKey && before?.snapshot.state === after?.snapshot.state && preparing(before) === preparing(after)) continue;
                if (beforeKey) affected.add(beforeKey);
                if (afterKey) affected.add(afterKey);
            }
            const notify = new Set<() => void>();
            for (const key of affected) {
                revisions.set(key, (revisions.get(key) ?? 0) + 1);
                for (const listener of listeners.get(key) ?? []) notify.add(listener);
            }
            for (const listener of notify) listener();
        },
    };
}
