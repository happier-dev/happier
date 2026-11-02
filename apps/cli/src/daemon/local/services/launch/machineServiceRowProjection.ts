import type { MachineServiceRowV1, MachineServiceWatchV1 } from '@happier-dev/protocol';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { managedServiceEndpointHostPolicyForMode, readManagedServiceEndpointUrl } from '@happier-dev/protocol/plugins/managedServiceEndpointUrl';
import type { ProjectManagedServiceHandle } from '@/plugins/runtime/invocation/services/managedServicesOwner';
import type { MachineManagedServiceHandle } from '@/plugins/runtime/invocation/services/machineManagedServices';

type ServiceHandle = ProjectManagedServiceHandle | MachineManagedServiceHandle;
export type MachineServiceRowChange = Readonly<{
    serverId: string; homeServerIdentityId: string | null; machineId: string; handle: ServiceHandle; row: MachineServiceRowV1 | null;
}>;

/** Projects retained service facts without native or access reads. */
export function createMachineServiceRowProjection(watchRevision: (watch: MachineServiceWatchV1) => string) {
    const observed = new WeakMap<ServiceHandle, MachineServiceRowV1>();
    const unavailable = new WeakMap<MachineServiceWatchV1, MachineServiceRowV1>();
    const published = new WeakMap<ServiceHandle, MachineServiceRowV1>();
    const listeners = new Map<string, Set<(change: MachineServiceRowChange) => void>>();
    const targetOf = (handle: ServiceHandle) => handle.kind === 'workspace' ? handle.workspace : handle;
    const deliver = (handle: ServiceHandle, row: MachineServiceRowV1 | null) => {
        const target = targetOf(handle);
        for (const listener of listeners.get(target.machineId) ?? []) {
            try { listener({ serverId: target.serverId, homeServerIdentityId: handle.homeServerIdentityId ?? null,
                machineId: target.machineId, handle, row }); }
            catch { /* One observer cannot change native custody. */ }
        }
    };
    const retire = (handle: ServiceHandle) => {
        if (!published.has(handle)) return;
        published.delete(handle);
        deliver(handle, null);
    };
    const projection = {
        read(handle: ServiceHandle): MachineServiceRowV1 {
            const snapshot = handle.snapshot();
            const previous = observed.get(handle);
            const endpoint = readManagedServiceEndpointUrl(snapshot.baseUrl, {
                hostPolicy: managedServiceEndpointHostPolicyForMode(snapshot.mode),
            });
            const native = snapshot.mode === 'native'
                ? { phase: snapshot.nativePhase ?? 'unknown', readiness: snapshot.readiness ?? 'not_reported' } as const
                : undefined;
            const facts = handle.kind !== 'adopted' ? handle.readNativeRuntimeFacts?.() : undefined;
            const freshness = facts?.freshness === 'current' ? 'current' : 'unavailable';
            const status = freshness !== 'current' ? 'unknown'
                : snapshot.state === 'unhealthy' || snapshot.state === 'stopped' || snapshot.nativePhase === 'stopped'
                    || snapshot.readiness === 'not_ready' ? 'down'
                    : snapshot.state === 'healthy' ? 'up' : 'unknown';
            const reason = freshness !== 'current' ? 'coverage_unavailable'
                : snapshot.nativePhase === 'stopped' ? 'stopped' : snapshot.readiness === 'not_ready' ? 'not_ready' : undefined;
            const health: NonNullable<MachineServiceRowV1['health']> = {
                status, observedAtMs: facts?.observedAt ?? null, freshness,
                ...(reason ? { reason } : {}),
                ...(handle.readHealthSnapshot?.().expectedDown ? { expectedDown: 'stop' } : {}),
            };
            // The clock identifies the adopted semantic proof, not every raw
            // native refresh. Explicit detail reads retain the latest raw clock.
            const prior = previous?.health;
            const stableHealth = prior && prior.status === health.status && prior.freshness === health.freshness
                && prior.reason === health.reason && prior.expectedDown === health.expectedDown ? prior : Object.freeze(health);
            const configuration = facts ? facts.configuration ? { ports: facts.configuration.ports } : null : undefined;
            const capabilities = handle.kind === 'adopted' ? handle.capabilities : {
                start: Boolean(handle.controlNative), stop: true, restart: Boolean(handle.controlNative),
                logs: Boolean(handle.readLogs), accounting: Boolean(handle.readAccounting),
            };
            const row: MachineServiceRowV1 = {
                serviceId: handle.serviceId,
                name: handle.kind === 'adopted' ? handle.watch.name : handle.kind === 'environment' ? handle.composeService : snapshot.id,
                authority: handle.kind === 'adopted' ? 'machine' : 'project',
                lifecyclePurpose: handle.lifecyclePurpose, generation: handle.instanceId, state: snapshot.state,
                baseUrl: endpoint.ok ? endpoint.endpoint.baseUrl : null,
                port: endpoint.ok ? endpoint.endpoint.port : null,
                ...(native ? { native: sameStrictJsonValue(previous?.native, native) ? previous!.native : Object.freeze(native) } : {}),
                ...(native ? { health: stableHealth } : {}),
                ...(facts ? { configuration: sameStrictJsonValue(previous?.configuration, configuration)
                    ? previous!.configuration : configuration } : {}),
                ...(handle.kind === 'environment' ? { environmentId: handle.environmentId } : {}),
                ...(handle.kind === 'environment' && handle.identity ? { deployment: previous?.deployment ?? Object.freeze({
                    deploymentId: handle.deploymentId, installationId: handle.release.installationId, service: handle.identity,
                }) } : {}),
                ...(handle.kind === 'adopted' ? {
                    // A watch edit replaces its immutable adopted handle.
                    watchId: handle.watch.watchId, watchRevision: previous?.watchRevision ?? watchRevision(handle.watch),
                    nativeInstance: handle.instance,
                } : {}),
                capabilities: sameStrictJsonValue(previous?.capabilities, capabilities)
                    ? previous!.capabilities : Object.freeze(capabilities),
            };
            if (previous && sameStrictJsonValue(previous, row)) return previous;
            const next = Object.freeze(row);
            observed.set(handle, next);
            return next;
        },
        unknown(watch: MachineServiceWatchV1): MachineServiceRowV1 {
            const previous = unavailable.get(watch);
            if (previous) return previous;
            const row: MachineServiceRowV1 = Object.freeze({
                serviceId: watch.watchId, name: watch.name, authority: 'machine',
                lifecyclePurpose: watch.lifecyclePurpose, generation: null, state: 'unknown',
                unavailableReason: 'admission_unavailable', watchId: watch.watchId, watchRevision: watchRevision(watch),
                nativeInstance: Object.freeze({ adapter: watch.adapter, nativeResourceId: watch.nativeResourceId }),
                native: Object.freeze({ phase: 'unknown', readiness: 'not_reported' }),
                capabilities: Object.freeze({ start: false, stop: false, restart: false, logs: false, accounting: false }),
            });
            unavailable.set(watch, row);
            return row;
        },
    };
    return { ...projection,
        publish(handle: ServiceHandle) {
            if (!listeners.has(targetOf(handle).machineId)) return;
            if (handle.retirementSignal.aborted || !handle.isCurrent()) { retire(handle); return; }
            const row = projection.read(handle);
            if (published.get(handle) === row) return;
            published.set(handle, row);
            deliver(handle, row);
        },
        retire,
        subscribe(machineId: string, initial: readonly ServiceHandle[], listener: (change: MachineServiceRowChange) => void) {
            let subscribers = listeners.get(machineId);
            if (!subscribers) { subscribers = new Set(); listeners.set(machineId, subscribers); }
            const active = subscribers;
            if (active.size === 0) for (const handle of initial) {
                if (handle.isCurrent() && !handle.retirementSignal.aborted) published.set(handle, projection.read(handle));
            }
            active.add(listener);
            return { dispose() { active.delete(listener); if (active.size === 0) listeners.delete(machineId); } };
        },
    };
}
