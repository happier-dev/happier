import { z } from 'zod';

export const EXECUTION_RUN_ADMISSION_PATH = '/execution-run/admission';
export const ExecutionRunDaemonAdmissionResponseSchema = z.discriminatedUnion('admitted', [
    z.object({ admitted: z.literal(true) }).strict(),
    z.object({ admitted: z.literal(false), reason: z.enum(['daemon_draining', 'daemon_shutting_down']) }).strict(),
]);

export type DaemonAdmissionDrain = Readonly<{
    isQuiescing(): boolean;
    isFinalShutdown(): boolean;
    isPublicationQuiescing(): boolean;
    beginTemporaryDrain(): void;
    beginUnusedStopDrain(): void;
    resumeUnusedStop(): void;
    resume(): void;
    beginShutdown(): void;
    notifyPluginHandoffChanged(): void;
    subscribe(listener: () => void): () => void;
}>;

/** One daemon lifecycle decision; plugin handoff retains its own exclusion custody. */
export function createDaemonAdmissionDrain(params: Readonly<{
    isPluginHandoffQuiescing?: () => boolean;
    isShutdownRequested?: () => boolean;
}> = {}): DaemonAdmissionDrain {
    let state: 'open' | 'draining' | 'shutdown' = 'open';
    let unusedStop = false;
    const listeners = new Set<() => void>();
    const isFinalShutdown = () => state === 'shutdown' || params.isShutdownRequested?.() === true;
    const isPublicationQuiescing = () => isFinalShutdown() || params.isPluginHandoffQuiescing?.() === true;
    const change = (next: typeof state) => {
        if (isFinalShutdown() && next !== 'shutdown') return;
        if (state === next && next !== 'open') return;
        state = next;
        for (const listener of listeners) listener();
    };
    return {
        isQuiescing: () => unusedStop || state === 'draining' || isPublicationQuiescing(),
        isFinalShutdown,
        isPublicationQuiescing,
        beginTemporaryDrain: () => change('draining'),
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
        resume: () => change('open'),
        beginShutdown: () => change('shutdown'),
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
