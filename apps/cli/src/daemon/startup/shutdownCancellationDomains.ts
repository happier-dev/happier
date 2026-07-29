import type { LocalServicesDaemonRuntime } from '@/daemon/local/services/runtime';

export type ManagedLocalServicesShutdownDisposition = 'permanent' | 'transfer';

/**
 * Daemon shutdown has two cancellation domains:
 * - ordinary daemon work always stops as shutdown begins;
 * - managed local-service process lifetime stops only for permanent shutdown.
 *
 * Keeping the signals here prevents graceful replacement from accidentally
 * propagating the ordinary daemon-work abort into a supervised survivor.
 */
export function createDaemonShutdownCancellationDomains(): Readonly<{
    daemonWorkSignal: AbortSignal;
    managedLocalServicesProcessSignal: AbortSignal;
    beginShutdown(): void;
    stopManagedLocalServices(
        runtime: Pick<LocalServicesDaemonRuntime, 'stop'>,
        disposition: ManagedLocalServicesShutdownDisposition,
    ): Promise<void>;
}> {
    const daemonWork = new AbortController();
    const managedLocalServicesProcess = new AbortController();

    return Object.freeze({
        daemonWorkSignal: daemonWork.signal,
        managedLocalServicesProcessSignal: managedLocalServicesProcess.signal,
        beginShutdown() {
            daemonWork.abort();
        },
        async stopManagedLocalServices(runtime, disposition) {
            try {
                await runtime.stop({ disposition });
            } finally {
                if (disposition === 'permanent') {
                    managedLocalServicesProcess.abort();
                }
            }
        },
    });
}
