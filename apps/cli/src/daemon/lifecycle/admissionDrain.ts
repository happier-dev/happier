import { z } from 'zod/mini';

export const EXECUTION_RUN_ADMISSION_PATH = '/execution-run/admission';
export const DaemonAdmissionRefusalCodeSchema = z.enum(['daemon_draining', 'daemon_shutting_down']);
export const ExecutionRunDaemonAdmissionResponseSchema = z.discriminatedUnion('admitted', [
    z.strictObject({ admitted: z.literal(true) }),
    z.strictObject({ admitted: z.literal(false), reason: DaemonAdmissionRefusalCodeSchema }),
]);

export type DaemonAdmissionDrain = Readonly<{
    isQuiescing(): boolean;
    isFinalShutdown(): boolean;
    isPublicationQuiescing(): boolean;
    /** Release withdraws only this caller's contribution and is idempotent. */
    beginTemporaryDrain(): () => void;
    beginUnusedStopDrain(): void;
    resumeUnusedStop(): void;
    beginShutdown(): void;
    notifyPluginHandoffChanged(): void;
    subscribe(listener: () => void): () => void;
}>;

/** One daemon lifecycle decision; plugin handoff retains its own exclusion custody. */
export function createDaemonAdmissionDrain(params: Readonly<{
    isPluginHandoffQuiescing?: () => boolean;
    isShutdownRequested?: () => boolean;
}> = {}): DaemonAdmissionDrain {
    let shuttingDown = false;
    let temporaryDrains = 0;
    let unusedStop = false;
    const listeners = new Set<() => void>();
    const isFinalShutdown = () => shuttingDown || params.isShutdownRequested?.() === true;
    const isPublicationQuiescing = () => isFinalShutdown() || params.isPluginHandoffQuiescing?.() === true;
    const isQuiescing = () => unusedStop || temporaryDrains > 0 || isPublicationQuiescing();
    const notify = () => { for (const listener of listeners) listener(); };
    return {
        isQuiescing,
        isFinalShutdown,
        isPublicationQuiescing,
        beginTemporaryDrain: () => {
            if (isFinalShutdown()) return () => {};
            const wasQuiescing = isQuiescing();
            temporaryDrains += 1;
            if (!wasQuiescing) notify();
            let released = false;
            return () => {
                if (released) return;
                released = true;
                temporaryDrains -= 1;
                if (!isQuiescing()) notify();
            };
        },
        beginUnusedStopDrain: () => {
            if (unusedStop || isFinalShutdown()) return;
            unusedStop = true;
            for (const listener of listeners) listener();
        },
        resumeUnusedStop: () => {
            if (!unusedStop || isFinalShutdown()) return;
            unusedStop = false;
            for (const listener of listeners) listener();
        },
        beginShutdown: () => {
            if (shuttingDown) return;
            shuttingDown = true;
            notify();
        },
        notifyPluginHandoffChanged: () => { for (const listener of listeners) listener(); },
        subscribe: (listener) => {
            listeners.add(listener);
            return () => { listeners.delete(listener); };
        },
    };
}

/** Park new claimed leaf starts without releasing their incumbent custody. */
export async function waitForDaemonAdmission(drain: DaemonAdmissionDrain, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (!drain.isQuiescing()) return;
    await new Promise<void>((resolve, reject) => {
        const cleanup = () => { unsubscribe(); signal?.removeEventListener('abort', abort); };
        const check = () => {
            if (drain.isFinalShutdown()) {
                cleanup();
                reject(Object.assign(new Error('Daemon is shutting down'), { code: 'daemon_shutting_down' }));
            } else if (!drain.isQuiescing()) { cleanup(); resolve(); }
        };
        const abort = () => { cleanup(); reject(signal?.reason); };
        const unsubscribe = drain.subscribe(check);
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort(); else check();
    });
}
