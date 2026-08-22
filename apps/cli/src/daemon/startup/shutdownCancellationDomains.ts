import type { LocalServicesDaemonRuntime } from '@/daemon/local/services/runtime';

/** Daemon shutdown aborts ordinary work, then retires the Local Services runtime. */
export function createDaemonShutdownCancellationDomains(): Readonly<{
    daemonWorkSignal: AbortSignal;
    beginShutdown(): void;
    stopManagedLocalServices(runtime: Pick<LocalServicesDaemonRuntime, 'stop'>): Promise<void>;
}> {
    const daemonWork = new AbortController();

    return Object.freeze({
        daemonWorkSignal: daemonWork.signal,
        beginShutdown() {
            daemonWork.abort();
        },
        async stopManagedLocalServices(runtime) {
            await runtime.stop();
        },
    });
}
