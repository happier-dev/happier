import type { ServiceExportMachineForward } from '@/daemon/peer/iroh/serviceExportMachineForward';
import { logger } from '@/ui/logger';
import type { PrivateServiceExportAdmissionForHost } from './privateServiceReference';
import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { MachineNativeEffectKey } from '@/daemon/local/services/launch/machineNativeEffectAdmission';

type Admission = Extract<PrivateServiceExportAdmissionForHost, { kind: 'iroh' | 'local' }>;
type RemovedConsumers = Readonly<{ consumers: ReadonlySet<AbortSignal>; keys: readonly MachineNativeEffectKey[] }>;
type CloseUnusedForward = (removed?: RemovedConsumers) => Promise<void> | undefined;
const closesByConsumer = new WeakMap<AbortSignal, Set<CloseUnusedForward>>();

async function settleForwardClosures(completions: readonly (Promise<void> | undefined)[]): Promise<void> {
    const failed = (await Promise.allSettled(completions)).find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
}

export function retainServiceReferenceForwardCleanup(consumers: readonly AbortSignal[],
    keys: readonly MachineNativeEffectKey[], close: () => Promise<void>) {
    const projects = keys.filter(key => key.kind === 'composeProject');
    const closeIfUnused: CloseUnusedForward = removed => {
        const proved = removed && projects.length > 0 && projects.every(project => removed.keys.some(key => key.kind === 'composeProject'
            && key.dockerEndpoint === project.dockerEndpoint && key.projectName === project.projectName)) ? removed.consumers : undefined;
        if (consumers.every(consumer => consumer.aborted || proved?.has(consumer))) return close();
    };
    for (const consumer of consumers) {
        let closes = closesByConsumer.get(consumer);
        if (!closes) closesByConsumer.set(consumer, closes = new Set());
        closes.add(closeIfUnused);
    }
    return {
        closeIfUnused,
        forget() {
            for (const consumer of consumers) closesByConsumer.get(consumer)?.delete(closeIfUnused);
        },
    };
}

/** Native teardown has proved these consumers' workloads absent. Other consumers still own their forwards. */
export async function releaseRemovedServiceReferenceForwards(consumers: ReadonlySet<AbortSignal>,
    keys: readonly MachineNativeEffectKey[]): Promise<void> {
    const closes = new Set<CloseUnusedForward>();
    for (const consumer of consumers) {
        for (const close of closesByConsumer.get(consumer) ?? []) closes.add(close);
    }
    await settleForwardClosures([...closes].map(close => close({ consumers, keys })));
}

/** Render/start share one local address; the retained service group owns it after activation. */
export function createServiceReferenceForwardCustody(input: Readonly<{
    signal: AbortSignal;
    acquire(admission: Admission, signal: AbortSignal): Promise<ServiceExportMachineForward>;
}>) {
    const forwards = new Map<string | ServiceExportMachineForward, { forward: Promise<ServiceExportMachineForward>; failure?: ActionExecuteFailure }>();
    const keyFor = (admission: Admission) => JSON.stringify([admission.machineId, admission.serviceExport]);
    const currentFailure = () => [...forwards.values()].find(entry => entry.failure)?.failure;
    const lifetime = new AbortController();
    const signal = AbortSignal.any([input.signal, lifetime.signal]);
    let retained = false;
    let closing: Promise<void> | undefined;
    let reportFailure: ((failure: ActionExecuteFailure | null) => void) | undefined;
    const removeConsumerListeners = new Set<() => void>();
    const forgetConsumerClosures = new Set<() => void>();
    const close = (): Promise<void> => closing ??= (async () => {
        input.signal.removeEventListener('abort', retire);
        for (const remove of removeConsumerListeners) remove();
        removeConsumerListeners.clear();
        reportFailure = undefined;
        lifetime.abort();
        try {
            const results = await Promise.allSettled([...forwards.values()].map(entry => entry.forward));
            await settleForwardClosures(results.flatMap(result => result.status === 'fulfilled' ? [result.value.close()] : []));
        } finally {
            for (const forget of forgetConsumerClosures) forget();
            forgetConsumerClosures.clear();
            forwards.clear();
        }
    })();
    const logCleanupFailure = (completion: Promise<void> | undefined) => {
        void completion?.catch(() => logger.infoFile('[Deployment] Private service forward cleanup failed',
            { code: 'private_service_forward_cleanup_failed' }));
    };
    const retire = () => logCleanupFailure(close());
    input.signal.addEventListener('abort', retire, { once: true });
    return {
        retire,
        adopt(forward: ServiceExportMachineForward) {
            signal.throwIfAborted();
            forwards.set(forward, { forward: Promise.resolve(forward) });
            return forward;
        },
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
        retain(consumers: readonly AbortSignal[], report?: (failure: ActionExecuteFailure | null) => void,
            keys: readonly MachineNativeEffectKey[] = []) {
            if (!forwards.size || !consumers.length) return;
            retained = true;
            reportFailure = report;
            const failure = currentFailure();
            if (failure) reportFailure?.(failure);
            const cleanup = retainServiceReferenceForwardCleanup(consumers, keys, close);
            forgetConsumerClosures.add(cleanup.forget);
            const onRetired = () => logCleanupFailure(cleanup.closeIfUnused());
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
