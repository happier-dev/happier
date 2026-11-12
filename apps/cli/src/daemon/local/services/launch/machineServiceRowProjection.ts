import type { MachineServiceDiscoveryCandidateV1, MachineServiceIdentityV1, MachineServiceRowV1, MachineServiceWatchV1 } from '@happier-dev/protocol';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { managedServiceEndpointHostPolicyForMode, readManagedServiceEndpointUrl } from '@happier-dev/protocol/plugins/managedServiceEndpointUrl';
import type { ProjectManagedServiceHandle } from '@/plugins/runtime/invocation/services/managedServicesOwner';
import type { MachineManagedServiceHandle } from '@/plugins/runtime/invocation/services/machineManagedServices';
import type { SavedMachineServiceHealthResult } from '@/deployments/healthChecks/savedHealthChecks';

type ServiceHandle = ProjectManagedServiceHandle | MachineManagedServiceHandle;
type RetainedHealthResult = { result: SavedMachineServiceHealthResult; detach(): void };
export type MachineServiceRowChange = Readonly<{
    serverId: string; homeServerIdentityId: string | null; machineId: string; handle: ServiceHandle; row: MachineServiceRowV1 | null;
}>;

const isHappierComposeName = (name: string) => /^happier-(?:g-)?[a-f0-9]{64}$/u.test(name);

/** Rows and discovery share the admitted label/identity; native hashes never establish Environment provenance. */
export function projectMachineServiceName(
    candidate: Readonly<{ name: string; adapter?: MachineServiceDiscoveryCandidateV1['adapter'] }>,
    service?: Pick<MachineServiceRowV1, 'name' | 'identity'>,
): Pick<MachineServiceDiscoveryCandidateV1, 'name' | 'identity' | 'nameResolution'> {
    const name = service?.name ?? candidate.name;
    return { name, ...(service?.identity ? { identity: service.identity } : {}),
        ...(service?.identity?.kind !== 'deployment' && candidate.adapter?.pluginId === 'happier.machine.services'
            && candidate.adapter.localId === 'compose' && isHappierComposeName(name)
            ? { nameResolution: 'unresolved_environment' as const } : {}),
    };
}

/** Projects retained service facts without native or access reads. */
export function createMachineServiceRowProjection(watchRevision: (watch: MachineServiceWatchV1) => string) {
    const observed = new WeakMap<ServiceHandle, MachineServiceRowV1>();
    const unavailable = new WeakMap<MachineServiceWatchV1, MachineServiceRowV1>();
    const published = new WeakMap<ServiceHandle, MachineServiceRowV1>();
    const listeners = new Map<string, Set<(change: MachineServiceRowChange) => void>>();
    const healthResults = new Map<ServiceHandle, Map<string, RetainedHealthResult>>();
    const statusRank = { up: 0, degraded: 1, unknown: 2, down: 3 } as const;
    const watchIdentity = (watch: MachineServiceWatchV1, machineId: string): Extract<MachineServiceIdentityV1, { kind: 'adopted' }> => Object.freeze({
        kind: 'adopted', machineId, serviceId: watch.watchId, watchId: watch.watchId, watchRevision: watchRevision(watch),
    });
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
        for (const entry of healthResults.get(handle)?.values() ?? []) entry.detach();
        healthResults.delete(handle);
        if (!published.has(handle)) return;
        published.delete(handle);
        deliver(handle, null);
    };
    const projection = {
        read(handle: ServiceHandle): MachineServiceRowV1 {
            const snapshot = handle.snapshot();
            const previous = observed.get(handle);
            const identity = previous?.identity ?? (handle.kind === 'environment' ? handle.identity
                : handle.kind === 'adopted' ? watchIdentity(handle.watch, handle.machineId) : undefined);
            const name = handle.kind === 'adopted' ? handle.watch.name : handle.kind === 'environment' ? handle.composeService
                : handle.declaration.selection.kind === 'manifest' ? handle.declaration.selection.name : handle.declaration.selection.source.target;
            const endpoint = readManagedServiceEndpointUrl(snapshot.baseUrl, {
                hostPolicy: managedServiceEndpointHostPolicyForMode(snapshot.mode),
            });
            // Resolve native custody names through the admitted handle, never by stripping their hash.
            const compose = handle.kind === 'environment'
                || (handle.kind === 'workspace' && handle.nativeTool === 'compose')
                || (handle.kind === 'adopted' && handle.instance.adapter.pluginId === 'happier.machine.services'
                    && handle.instance.adapter.localId === 'compose');
            const displayName = compose && snapshot.nativeDisplayName !== undefined
                && isHappierComposeName(snapshot.nativeDisplayName) ? name : snapshot.nativeDisplayName;
            const native = snapshot.mode === 'native'
                ? { phase: snapshot.nativePhase ?? 'unknown', readiness: snapshot.readiness ?? 'not_reported',
                    ...(displayName !== undefined ? { displayName } : {}),
                    ...(handle.kind === 'adopted' && snapshot.nativeComposeServices !== undefined
                        ? { composeServices: snapshot.nativeComposeServices } : {}) } as const
                : undefined;
            const facts = handle.readNativeRuntimeFacts?.();
            const freshness = facts?.freshness === 'current' ? 'current' : 'unavailable';
            const status = freshness !== 'current' ? 'unknown'
                : snapshot.state === 'unhealthy' || snapshot.state === 'stopped' || snapshot.nativePhase === 'stopped'
                    || snapshot.readiness === 'not_ready' ? 'down'
                    : snapshot.state === 'healthy' ? 'up' : 'unknown';
            const reason = freshness !== 'current' ? 'coverage_unavailable'
                : snapshot.nativePhase === 'stopped' ? 'stopped' : snapshot.readiness === 'not_ready' ? 'not_ready' : undefined;
            const nativeHealth: NonNullable<MachineServiceRowV1['health']> = {
                status, observedAtMs: facts?.observedAt ?? null, freshness,
                ...(facts?.healthSince === undefined ? {} : { since: facts.healthSince }),
                ...(reason ? { reason } : {}),
                ...(handle.readHealthSnapshot?.().expectedDown ? { expectedDown: 'stop' } : {}),
            };
            // Native failures remain authoritative; otherwise the admitted saved
            // checks supply readiness that native adapters do not report.
            let checkResult: SavedMachineServiceHealthResult | undefined;
            for (const { result } of healthResults.get(handle)?.values() ?? []) {
                if (!checkResult || statusRank[result.result.status] > statusRank[checkResult.result.status]) checkResult = result;
            }
            const dependencyFailure = handle.kind !== 'adopted' ? handle.readDependencyFailure?.() : undefined;
            const health: NonNullable<MachineServiceRowV1['health']> = nativeHealth.status === 'down' ? nativeHealth : dependencyFailure
                ? { ...nativeHealth, status: 'down', reason: dependencyFailure.errorCode }
                : checkResult
                ? { status: checkResult.result.status, observedAtMs: checkResult.result.observedAt, freshness: 'current',
                    ...(nativeHealth.expectedDown ? { expectedDown: nativeHealth.expectedDown } : {}) }
                : nativeHealth;
            // The clock identifies the adopted semantic proof, not every raw
            // native refresh. Explicit detail reads retain the latest raw clock.
            const prior = previous?.health;
            const stableHealth = prior && prior.status === health.status && prior.freshness === health.freshness
                && prior.reason === health.reason && prior.expectedDown === health.expectedDown && prior.since === health.since ? prior : Object.freeze(health);
            const configuration = facts ? facts.configuration ? { ports: facts.configuration.ports } : null : undefined;
            const capabilities = handle.kind === 'adopted' ? handle.capabilities : {
                exec: Boolean(handle.executeServiceCommand),
                start: handle.kind === 'environment' && handle.nativeControlCapabilities?.start === true,
                stop: handle.kind === 'environment' && handle.nativeControlCapabilities?.stop === true,
                restart: handle.kind === 'environment' && handle.nativeControlCapabilities?.restart === true,
                logs: Boolean(handle.readLogs), accounting: Boolean(handle.readAccounting),
            };
            const row: MachineServiceRowV1 = {
                serviceId: handle.serviceId,
                ...projectMachineServiceName({ name, ...(handle.kind === 'adopted' ? { adapter: handle.instance.adapter } : {}) }, { name, identity }),
                authority: handle.kind === 'adopted' ? 'machine' : 'project',
                lifecyclePurpose: handle.lifecyclePurpose, generation: handle.instanceId, state: snapshot.state,
                baseUrl: endpoint.ok ? endpoint.endpoint.baseUrl : null,
                port: endpoint.ok ? endpoint.endpoint.port : null,
                ...(native ? { native: sameStrictJsonValue(previous?.native, native) ? previous!.native : Object.freeze(native) } : {}),
                ...(native || checkResult ? { health: stableHealth } : {}),
                ...(facts?.accounting ? { accounting: sameStrictJsonValue(previous?.accounting, facts.accounting)
                    ? previous!.accounting : Object.freeze({ ...facts.accounting }) } : {}),
                ...(facts ? { configuration: sameStrictJsonValue(previous?.configuration, configuration)
                    ? previous!.configuration : configuration } : {}),
                ...(handle.kind === 'environment' ? { environmentId: handle.environmentId } : {}),
                ...(handle.kind === 'environment' && handle.identity ? { deployment: previous?.deployment ?? Object.freeze({
                    deploymentId: handle.deploymentId, installationId: handle.release.installationId, service: handle.identity,
                }) } : {}),
                ...(handle.kind === 'adopted' ? {
                    // A watch edit replaces its immutable adopted handle.
                    watchId: handle.watch.watchId, watchRevision: identity?.kind === 'adopted' ? identity.watchRevision : watchRevision(handle.watch),
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
        unknown(watch: MachineServiceWatchV1, machineId: string): MachineServiceRowV1 {
            const previous = unavailable.get(watch);
            if (previous) return previous;
            const identity = watchIdentity(watch, machineId);
            const row: MachineServiceRowV1 = Object.freeze({
                serviceId: watch.watchId, authority: 'machine',
                ...projectMachineServiceName({ name: watch.name, adapter: watch.adapter }, { name: watch.name, identity }),
                lifecyclePurpose: watch.lifecyclePurpose, generation: null, state: 'unknown',
                unavailableReason: 'admission_unavailable', watchId: watch.watchId, watchRevision: identity.watchRevision,
                nativeInstance: Object.freeze({ adapter: watch.adapter, nativeResourceId: watch.nativeResourceId }),
                native: Object.freeze({ phase: 'unknown', readiness: 'not_reported' }),
                capabilities: Object.freeze({ exec: false, start: false, stop: false, restart: false, logs: false, accounting: false }),
            });
            unavailable.set(watch, row);
            return row;
        },
    };
    const publish = (handle: ServiceHandle) => {
        if (!listeners.has(targetOf(handle).machineId)) return;
        if (handle.retirementSignal.aborted || !handle.isCurrent()) { retire(handle); return; }
        const row = projection.read(handle);
        if (published.get(handle) === row) return;
        published.set(handle, row);
        deliver(handle, row);
    };
    return { ...projection, publish,
        publishHealthResult(handle: ServiceHandle, result: SavedMachineServiceHealthResult) {
            const target = targetOf(handle);
            if (target.serverId !== result.serverId || target.machineId !== result.subject.machineId
                || handle.serviceId !== result.subject.serviceId || handle.instanceId !== result.generation
                || handle.retirementSignal.aborted || !handle.isCurrent() || result.retirementSignal?.aborted) return;
            const results = healthResults.get(handle) ?? new Map<string, RetainedHealthResult>();
            healthResults.set(handle, results);
            const key = JSON.stringify([result.caller, result.occurrenceId, result.sourceInstanceId, result.check.checkId]);
            const previous = results.get(key);
            if (previous && previous.result.retirementSignal === result.retirementSignal) {
                previous.result = result;
            } else {
                previous?.detach();
                const withdraw = () => {
                    if (results.get(key) !== retained) return;
                    results.delete(key);
                    retained.detach();
                    if (!results.size) healthResults.delete(handle);
                    publish(handle);
                };
                const retained: RetainedHealthResult = { result,
                    detach: () => result.retirementSignal?.removeEventListener('abort', withdraw) };
                results.set(key, retained);
                result.retirementSignal?.addEventListener('abort', withdraw, { once: true });
            }
            publish(handle);
        },
        reconcileHealthResults(isCurrent: (result: SavedMachineServiceHealthResult) => boolean) {
            for (const [handle, results] of healthResults) {
                let changed = false;
                for (const [key, entry] of results) {
                    if (isCurrent(entry.result)) continue;
                    entry.detach();
                    results.delete(key); changed = true;
                }
                if (!results.size) healthResults.delete(handle);
                if (changed) publish(handle);
            }
        },
        retire,
        subscribe(machineId: string, initial: readonly ServiceHandle[], listener: (change: MachineServiceRowChange) => void) {
            let subscribers = listeners.get(machineId);
            if (!subscribers) { subscribers = new Set(); listeners.set(machineId, subscribers); }
            const active = subscribers;
            for (const handle of initial) {
                if ((active.size === 0 || !published.has(handle)) && handle.isCurrent() && !handle.retirementSignal.aborted)
                    published.set(handle, projection.read(handle));
            }
            active.add(listener);
            return { dispose() { active.delete(listener); if (active.size === 0) listeners.delete(machineId); } };
        },
    };
}
