import { z } from 'zod/mini';

export const EXECUTION_RUN_ADMISSION_PATH = '/execution-run/admission';
export const DaemonAdmissionRefusalCodeSchema = z.enum(['daemon_draining', 'daemon_shutting_down']);
export const ExecutionRunDaemonAdmissionResponseSchema = z.discriminatedUnion('admitted', [
    z.strictObject({ admitted: z.literal(true) }),
    z.strictObject({ admitted: z.literal(false), reason: DaemonAdmissionRefusalCodeSchema }),
]);

type DaemonAdmissionRefusalCode = z.infer<typeof DaemonAdmissionRefusalCodeSchema>;
type AdmissionDecision = 'wait' | DaemonAdmissionRefusalCode | undefined;

export type DaemonAdmissionDrain = Readonly<{
    readSessionSpawnAdmission(): AdmissionDecision;
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
        readSessionSpawnAdmission: () => {
            if (isFinalShutdown()) return 'daemon_shutting_down';
            if (unusedStop) return 'daemon_draining';
            if (temporaryDrains > 0 || params.isPluginHandoffQuiescing?.() === true) return 'wait';
        },
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

function waitForAdmissionDecision(drain: DaemonAdmissionDrain, read: () => AdmissionDecision, signal?: AbortSignal) {
    return new Promise<DaemonAdmissionRefusalCode | undefined>((resolve, reject) => {
        const cleanup = () => { unsubscribe(); signal?.removeEventListener('abort', abort); };
        const check = () => {
            const decision = read();
            if (decision === 'wait') return;
            cleanup();
            resolve(decision);
        };
        const abort = () => { cleanup(); reject(signal?.reason); };
        const unsubscribe = drain.subscribe(check);
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort(); else check();
    });
}

/** Park new claimed leaf starts without releasing their incumbent custody. */
export async function waitForDaemonAdmission(drain: DaemonAdmissionDrain, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (!drain.isQuiescing()) return;
    const refusal = await waitForAdmissionDecision(drain,
        () => drain.isFinalShutdown() ? 'daemon_shutting_down' : drain.isQuiescing() ? 'wait' : undefined, signal);
    if (refusal) throw Object.assign(new Error('Daemon is shutting down'), { code: refusal });
}

/** A reversible read can finish normally. A committed Stop owns the guest until explicit reopen. */
export async function waitForSessionSpawnAdmission(drain: DaemonAdmissionDrain, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const decision = drain.readSessionSpawnAdmission();
    return decision === 'wait' ? await waitForAdmissionDecision(drain, drain.readSessionSpawnAdmission, signal) : decision;
}
