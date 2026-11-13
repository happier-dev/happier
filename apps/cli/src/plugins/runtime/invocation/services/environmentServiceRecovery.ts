import type { MachineServiceRowV1 } from '@happier-dev/protocol';

export type EnvironmentServiceRecoveryRow = MachineServiceRowV1 & Readonly<{ environmentId: string }>;

/** A requested Home/Machine inventory joins one recovery at the retained
 * service owner. Failed reads remain retryable at the next requested read. */
export function createEnvironmentServiceRecovery() {
    const recoveries = new Map<string, Promise<readonly EnvironmentServiceRecoveryRow[]>>();
    return (target: Readonly<{ serverId: string; machineId: string }>, restore: () => Promise<void | readonly EnvironmentServiceRecoveryRow[]>, signal?: AbortSignal): Promise<readonly EnvironmentServiceRecoveryRow[]> => {
        signal?.throwIfAborted();
        const key = JSON.stringify([target.serverId, target.machineId]);
        const existing = recoveries.get(key);
        if (existing) return existing;
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
