import type { ServiceExportMachineForward } from '@/daemon/peer/iroh/serviceExportMachineForward';
import { logger } from '@/ui/logger';
import type { PrivateServiceExportAdmissionForHost } from './privateServiceReference';
import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';

type Admission = Extract<PrivateServiceExportAdmissionForHost, { kind: 'iroh' | 'local' }>;

/** Render/start share one local address; the retained service group owns it after activation. */
export function createServiceReferenceForwardCustody(input: Readonly<{
    signal: AbortSignal;
    acquire(admission: Admission, signal: AbortSignal): Promise<ServiceExportMachineForward>;
}>) {
    const forwards = new Map<string, { forward: Promise<ServiceExportMachineForward>; failure?: ActionExecuteFailure }>();
    const keyFor = (admission: Admission) => JSON.stringify([admission.machineId, admission.serviceExport]);
    const currentFailure = () => [...forwards.values()].find(entry => entry.failure)?.failure;
    const lifetime = new AbortController();
    const signal = AbortSignal.any([input.signal, lifetime.signal]);
    let retained = false;
    let closing: Promise<void> | undefined;
    let reportFailure: ((failure: ActionExecuteFailure | null) => void) | undefined;
    const removeConsumerListeners = new Set<() => void>();
    const close = (): Promise<void> => closing ??= (async () => {
        input.signal.removeEventListener('abort', retire);
        for (const remove of removeConsumerListeners) remove();
        removeConsumerListeners.clear();
        reportFailure = undefined;
        lifetime.abort();
        const results = await Promise.allSettled([...forwards.values()].map(entry => entry.forward));
        await Promise.all(results.flatMap(result => result.status === 'fulfilled' ? [result.value.close()] : []));
        forwards.clear();
    })();
    const retire = () => { void close().catch(() => logger.infoFile('[Deployment] Private service forward cleanup failed',
        { code: 'private_service_forward_cleanup_failed' })); };
    input.signal.addEventListener('abort', retire, { once: true });
    return {
        retire,
        reportFailure(admission: Admission, value: ActionExecuteFailure | null) {
            const entry = forwards.get(keyFor(admission));
            if (!entry) return;
            entry.failure = value ?? undefined;
            reportFailure?.(currentFailure() ?? null);
        },
        acquire(admission: Admission) {
            signal.throwIfAborted();
            const key = keyFor(admission);
            let entry = forwards.get(key);
            if (!entry) {
                const forward = input.acquire(admission, signal);
                entry = { forward };
                forwards.set(key, entry);
                void forward.catch(() => { if (forwards.get(key)?.forward === forward) forwards.delete(key); });
            }
            return entry.forward;
        },
        retain(consumers: readonly AbortSignal[], report?: (failure: ActionExecuteFailure | null) => void) {
            if (!forwards.size || !consumers.length) return;
            retained = true;
            reportFailure = report;
            const failure = currentFailure();
            if (failure) reportFailure?.(failure);
            const onRetired = () => {
                if (!consumers.every(consumer => consumer.aborted)) return;
                for (const consumer of consumers) consumer.removeEventListener('abort', onRetired);
                retire();
            };
            removeConsumerListeners.add(() => { for (const consumer of consumers) consumer.removeEventListener('abort', onRetired); });
            for (const consumer of consumers) consumer.addEventListener('abort', onRetired, { once: true });
            onRetired();
        },
        async release() {
            if (retained) return;
            input.signal.removeEventListener('abort', retire);
            await close();
        },
    };
}
