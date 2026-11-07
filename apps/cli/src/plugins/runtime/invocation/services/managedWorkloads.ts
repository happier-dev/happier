import { PluginError } from '@happier-dev/plugin-sdk';
import type { Disposable, PluginCancellationOptions } from '@happier-dev/plugin-sdk';
import type { ManagedServices, ManagedWorkloadHandleV1 } from '@happier-dev/plugin-sdk/managed-services';
import { selectVisibleMachineProjectServices, type MachineServiceDisclosureRequest } from '@/daemon/local/services/launch/machineServiceDisclosure';
import type { ProjectManagedServiceHandle } from './managedServicesOwner';
import type { createMachineServiceRowProjection } from '@/daemon/local/services/launch/machineServiceRowProjection';

/** Host-only resource admission. No authority or source-custody operands reach the SDK. */
export type ManagedWorkloadAdmissionForHost = Readonly<{
    target: Readonly<{ serverId: string; machineId: string }>;
    disclosure: MachineServiceDisclosureRequest;
    signal: AbortSignal;
    ensureRecovered(): Promise<void>;
    /** Narrows an already admitted resource; it never grants access. */
    select?(handle: ProjectManagedServiceHandle): boolean;
    /** Present only for an admitted native mutation, with its existing operation custody. */
    control?(handle: ProjectManagedServiceHandle, operation: 'start' | 'stop' | 'restart',
        options?: PluginCancellationOptions): ReturnType<ManagedWorkloadHandleV1['control']>;
}>;

/** A view of incumbent supervisor records, not another service or process owner. */
export function bindManagedWorkloadsForHost(owner: Readonly<{
    listProjectServices(): readonly ProjectManagedServiceHandle[];
    machineServiceRows: ReturnType<typeof createMachineServiceRowProjection>;
}>, admission: ManagedWorkloadAdmissionForHost): ManagedServices['observeWorkload'] {
    return async (request, options) => {
        const signal = AbortSignal.any([admission.signal, ...(options?.signal ? [options.signal] : [])]);
        if (signal.aborted) return { kind: 'unavailable', reason: 'cancelled' };
        try { await admission.ensureRecovered(); }
        catch { return { kind: 'unavailable', reason: signal.aborted ? 'cancelled' : 'admission_unavailable' }; }
        if (signal.aborted) return { kind: 'unavailable', reason: 'cancelled' };
        const visible = await selectVisibleMachineProjectServices(admission.target,
            owner.listProjectServices().filter(handle => !admission.select || admission.select(handle)),
            admission.disclosure, request.serviceId);
        if (signal.aborted) return { kind: 'unavailable', reason: 'cancelled' };
        const handle = visible[0];
        // Missing and undisclosed resources have the same public result.
        if (!handle) return { kind: 'unavailable', reason: 'denied' };
        const detached = new AbortController();
        const lifetime = AbortSignal.any([signal, handle.retirementSignal, detached.signal]);
        const observations = new Set<Disposable>();
        const logWatches = new Set<Disposable>();
        let disposal: Promise<void> | undefined;
        const assertAttached = () => {
            if (lifetime.aborted) throw new PluginError({ code: 'plugin_managed_service_unavailable',
                message: 'Workload observation is detached' });
        };
        const dispose = (): Promise<void> => disposal ??= Promise.resolve().then(async () => {
            lifetime.removeEventListener('abort', onAbort);
            detached.abort();
            for (const observation of observations) observation.dispose();
            observations.clear();
            await Promise.all([...logWatches].map(watch => watch.dispose()));
            logWatches.clear();
        });
        const onAbort = () => { void dispose().catch(() => {}); };
        lifetime.addEventListener('abort', onAbort, { once: true });
        const workload: ManagedWorkloadHandleV1 = Object.freeze({
            snapshot() { assertAttached(); return owner.machineServiceRows.read(handle); },
            observe(listener) {
                assertAttached();
                const subscription = owner.machineServiceRows.subscribe(admission.target.machineId, [handle], change => {
                    if (!lifetime.aborted && change.handle === handle && change.row) listener(change.row);
                });
                const observation = { dispose() { subscription.dispose(); observations.delete(observation); } };
                observations.add(observation);
                try { listener(owner.machineServiceRows.read(handle)); }
                catch (error) { observation.dispose(); throw error; }
                return observation;
            },
            async control(operation, controlOptions) {
                assertAttached();
                if (!admission.control) return { kind: 'unsupported', reason: 'unsupported' };
                return admission.control(handle, operation, { signal: AbortSignal.any([
                    lifetime, ...(controlOptions?.signal ? [controlOptions.signal] : []),
                ]) });
            },
            async readLogs(logOptions) {
                assertAttached();
                if (!handle.readLogs) return { kind: 'unavailable', reason: 'unsupported' };
                return handle.readLogs({ ...logOptions, signal: AbortSignal.any([
                    lifetime, ...(logOptions?.signal ? [logOptions.signal] : []),
                ]) });
            },
            async watchLogs(logOptions) {
                assertAttached();
                if (!handle.watchLogs) throw new PluginError({ code: 'plugin_managed_service_unavailable',
                    message: 'Native log follow is unsupported' });
                const subscription = await handle.watchLogs({ ...logOptions, signal: AbortSignal.any([
                    lifetime, ...(logOptions.signal ? [logOptions.signal] : []),
                ]) });
                const watch = { async dispose() { await subscription.dispose(); logWatches.delete(watch); } };
                if (lifetime.aborted) { await watch.dispose(); assertAttached(); }
                logWatches.add(watch);
                return watch;
            },
            dispose,
        });
        return { kind: 'ready', workload };
    };
}
