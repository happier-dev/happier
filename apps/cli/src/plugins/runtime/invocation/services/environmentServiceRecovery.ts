import type { MachineServiceRowV1 } from '@happier-dev/protocol';

export type EnvironmentServiceRecoveryRow = MachineServiceRowV1 & Readonly<{ environmentId: string }>;
export type EnvironmentServiceRecoveryScope = Readonly<{
    environmentId: string;
    serviceId?: string;
    composeService?: string;
}>;
export type EnsureEnvironmentServices = (scope?: EnvironmentServiceRecoveryScope) => Promise<void>;

/** Each requested inventory joins the retained service owner at its demand
 * scope. Failed reads remain retryable at the next requested read. */
export function createEnvironmentServiceRecovery() {
    const recoveries = new Map<string, Promise<readonly EnvironmentServiceRecoveryRow[]>>();
    return function recover(target: Readonly<{ serverId: string; machineId: string; environmentId?: string }>,
        restore: () => Promise<void | readonly EnvironmentServiceRecoveryRow[]>, signal?: AbortSignal): Promise<readonly EnvironmentServiceRecoveryRow[]> {
        signal?.throwIfAborted();
        const { serverId, machineId, environmentId } = target;
        const key = JSON.stringify([serverId, machineId, environmentId]);
        const existing = recoveries.get(key);
        if (existing) return existing;
        if (environmentId !== undefined) {
            const inventory = recoveries.get(JSON.stringify([serverId, machineId, null]));
            // Full discovery can satisfy exact demand. A failure establishing
            // the full inventory leaves the selected Environment independently readable.
            if (inventory) return inventory.catch(() => recover(target, restore, signal));
        }
        const forget = () => { if (recoveries.get(key) === recovery) recoveries.delete(key); };
        const recovery = Promise.resolve().then(restore).then(rows => {
            const result = rows ?? [];
            // Partial recovery retains its evidence for this read and uses the
            // existing next-request retry boundary, just like a rejected read.
            if (result.length) {
                signal?.removeEventListener('abort', forget);
                forget();
            }
            return result;
        }).catch(error => {
            signal?.removeEventListener('abort', forget);
            forget();
            throw error;
        });
        recoveries.set(key, recovery);
        signal?.addEventListener('abort', forget, { once: true });
        return recovery;
    };
}
