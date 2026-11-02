/** A requested Home/Machine inventory joins one recovery at the retained
 * service owner. Failed reads remain retryable at the next requested read. */
export function createEnvironmentServiceRecovery() {
    const recoveries = new Map<string, Promise<void>>();
    return (target: Readonly<{ serverId: string; machineId: string }>, restore: () => Promise<void>, signal?: AbortSignal): Promise<void> => {
        signal?.throwIfAborted();
        const key = JSON.stringify([target.serverId, target.machineId]);
        const existing = recoveries.get(key);
        if (existing) return existing;
        const forget = () => { if (recoveries.get(key) === recovery) recoveries.delete(key); };
        const recovery = Promise.resolve().then(restore).catch(error => {
            signal?.removeEventListener('abort', forget);
            forget();
            throw error;
        });
        recoveries.set(key, recovery);
        signal?.addEventListener('abort', forget, { once: true });
        return recovery;
    };
}
