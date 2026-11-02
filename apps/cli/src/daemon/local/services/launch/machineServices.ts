import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/actionExecutor';
import { ActionExecuteFailureSchema, type ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { createHash, randomUUID } from 'node:crypto';
import {
    MACHINE_SERVICE_ACTION_INPUT_SCHEMAS, MACHINE_SERVICE_ACTION_OUTPUT_SCHEMAS,
    MachineServiceWatchV1Schema, MachineServiceWatchesFieldV1, MachineServiceDiscoveryCandidateV1Schema,
    MachineServiceAccountingV1Schema, getMachineServiceWatchesV1, readMachineServiceWatchesV1,
    mutateMachineServiceWatchesV1, machineServiceNativeIdentityKeyV1,
    type MachineMetadataFieldPortV1, type MachineMetadataFieldReadV1, type MachineServiceWatchV1,
    type MachineServiceWatchesV1, type MachineServiceRowV1, type MachineServiceActionOutput,
    type MachineServiceDiscoveryCandidateV1, type MachineServicesDiscoveryResultV1,
    type MachineServiceAccountingV1,
} from '@happier-dev/protocol';
import type { PluginContributionIdentityV1 } from '@happier-dev/protocol/plugins/contribution-identity';
import type { ProjectManagedServiceHandle } from '@/plugins/runtime/invocation/services/managedServicesOwner';
import type { MachineManagedServiceHandle } from '@/plugins/runtime/invocation/services/machineManagedServices';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { tryAcquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import { preserveUnconfirmedNativeProcess } from '@/plugins/runtime/lifecycle/contributions/targetProjectNativeAdapters';
import { isServerProfileHomeIdentity, resolveServerProfileHomeIdentityId } from '@/server/serverProfiles';
import { createMachineServiceRowProjection } from './machineServiceRowProjection';
import { selectVisibleMachineProjectServices, type MachineServiceDisclosureRequest } from './machineServiceDisclosure';

type Invocation = Parameters<NonNullable<ActionExecutorDeps['machineServiceAction']>>[0] & MachineServiceDisclosureRequest;
type ServiceHandle = ProjectManagedServiceHandle | MachineManagedServiceHandle;
const unavailable = (reason: 'admission_unavailable' | 'unavailable' | 'unsupported' | 'denied' | 'cancelled' = 'admission_unavailable') => (
    { kind: 'unavailable' as const, reason }
);
function revision(value: MachineServiceWatchV1 | MachineServiceWatchesV1 | readonly unknown[]): string {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function sameWatch(left: MachineServiceWatchV1, right: MachineServiceWatchV1): boolean {
    return MachineServiceWatchesFieldV1.equal({ v: 1, watches: [left] }, { v: 1, watches: [right] });
}
/** Projects and adopts through the incumbent registry/capture/supervisor owners.
 * Persisted intent is the only local state source; native observations remain on their handles. */
export function createMachineServicesRuntime(input: Readonly<{
    target: Readonly<{ serverId: string; machineId: string }>;
    readMetadata(): MachineMetadataFieldReadV1;
    captureMetadataPort(): MachineMetadataFieldPortV1;
    restoreEnvironmentServices?(owner: ResolvedExecutablePluginRuntimeRegistry['projectManagedServices'], signal: AbortSignal): Promise<void>;
}>): Readonly<{ execute(request: Invocation): Promise<MachineServiceActionOutput | ActionExecuteFailure>; reconcile(): Promise<void>; ensureEnvironmentServices(): Promise<void>; dispose(): Promise<void> }> {
    let disposed = false;
    const rows = createMachineServiceRowProjection(revision);
    const lifetime = new AbortController();
    const target = Object.freeze({ ...input.target });
    type Intent = Readonly<{ watches: MachineServiceWatchesV1; byId: ReadonlyMap<string, MachineServiceWatchV1> }>;
    let source: unknown = Symbol('unread');
    let admitted: Intent | null = null;
    let reconciled: Intent | null | undefined;
    let registry: ResolvedExecutablePluginRuntimeRegistry | undefined;
    let reconciliation: Promise<void> | undefined;
    const adoptedHandles = new Map<string, MachineManagedServiceHandle>();
    const readIntent = () => {
        const metadata = input.readMetadata();
        if (metadata.status !== 'ready') {
            source = Symbol('unread');
            admitted = null;
            return null;
        }
        if (source === metadata.metadata.serviceWatchesV1) return admitted;
        source = metadata.metadata.serviceWatchesV1;
        const watches = readMachineServiceWatchesV1(metadata.metadata);
        if (watches.status !== 'ready') { admitted = null; return null; }
        const byId = new Map(watches.policy.watches.map(watch => {
            const previous = admitted?.byId.get(watch.watchId);
            return [watch.watchId, previous && sameWatch(previous, watch) ? previous : watch] as const;
        }));
        const retained = [...byId.values()];
        const previous = admitted;
        if (previous && retained.length === previous.watches.watches.length
            && retained.every((watch, index) => watch === previous.watches.watches[index])) return previous;
        admitted = { watches: { v: 1, watches: retained }, byId };
        return admitted;
    };
    const watchCurrent = (watch: MachineServiceWatchV1) => {
        const current = !disposed ? readIntent()?.byId.get(watch.watchId) : undefined;
        return current !== undefined && (current === watch || sameWatch(current, watch));
    };
    const exact = (handle: MachineManagedServiceHandle) => handle.serverId === target.serverId && handle.machineId === target.machineId;
    async function reconcileCurrent(serviceId?: string): Promise<void> {
        if (disposed) return;
        const lease = tryAcquireAuthoritativePluginRuntimeRegistryLease();
        if (!lease) return;
        try {
            let intent = readIntent();
            const owner = lease.registry.projectManagedServices;
            const transferred = (watch: MachineServiceWatchV1) => {
                const incumbent = owner.resolveNativeService(watch, target);
                return incumbent !== null && incumbent.authority !== 'machine' && incumbent.handle !== null;
            };
            if (intent?.watches.watches.some(transferred)) {
                // Native custody wins immediately, even while encrypted metadata
                // cannot yet retire the old intent. Unwatch only detaches.
                const retained = intent.watches.watches.filter(watch => !transferred(watch));
                await owner.retireMachineServices({ ...target, retainWatches: retained });
                for (const [id, handle] of adoptedHandles) if (transferred(handle.watch)) adoptedHandles.delete(id);
                const port = input.captureMetadataPort();
                const current = await getMachineServiceWatchesV1(port);
                if (current.status === 'ready') {
                    const watches = current.policy.watches.filter(watch => !transferred(watch));
                    if (watches.length !== current.policy.watches.length) {
                        await mutateMachineServiceWatchesV1({ expectedMetadataVersion: current.metadataVersion,
                            expectedWatches: current.policy, watches: { v: 1, watches } }, port, { signal: lifetime.signal });
                    }
                }
                intent = readIntent();
            }
            const sameRegistry = registry === lease.registry;
            const demanded = serviceId ? intent?.byId.get(serviceId) : undefined;
            const changed = !sameRegistry || reconciled !== intent;
            if (!changed) {
                const handle = demanded ? adoptedHandles.get(demanded.watchId) : undefined;
                if (!demanded || handle && handle.isCurrent() && !handle.retirementSignal.aborted) return;
                // An explicit exact read can recover a retired observation without
                // activating every other saved, unavailable watch.
                adoptedHandles.delete(demanded.watchId);
            }
            if (!sameRegistry) {
                adoptedHandles.clear();
                for (const handle of owner.listMachineServices()) if (exact(handle)) adoptedHandles.set(handle.watch.watchId, handle);
            }
            const watches = changed ? intent?.watches.watches ?? [] : demanded ? [demanded] : [];
            if (changed) {
                await owner.retireMachineServices({ ...target, retainWatches: watches.filter(watch => {
                    const handle = adoptedHandles.get(watch.watchId);
                    return !handle || handle.isCurrent() && !handle.retirementSignal.aborted;
                }) });
                for (const [id, handle] of adoptedHandles) {
                    if (!intent?.byId.has(id) || !handle.isCurrent() || handle.retirementSignal.aborted) adoptedHandles.delete(id);
                }
            }
            for (const watch of watches) {
                if (changed && sameRegistry && reconciled?.byId.get(watch.watchId) === watch && watch.watchId !== serviceId) continue;
                if (!watchCurrent(watch)) continue;
                const handle = adoptedHandles.get(watch.watchId);
                if (handle && sameWatch(handle.watch, watch) && handle.isCurrent() && !handle.retirementSignal.aborted) continue;
                const incumbent = owner.resolveNativeService(watch, target);
                if (incumbent && incumbent.authority !== 'machine') continue;
                const selected = await lease.registry.resolveProjectNativeAdapter(watch.adapter, 'nativeServiceLifecycle');
                if (selected.kind !== 'ready' || !watchCurrent(watch)) continue;
                const captured = selected.lease.captureNativeServiceLifecycle(watch, { machine: target, signal: lifetime.signal });
                if (captured.kind !== 'ready') continue;
                // The semantic owner takes release custody, including failed/pending establishment.
                try {
                    const established = await owner.superviseMachine({ ...target, watch, lifecycle: captured.lifecycle, signal: lifetime.signal,
                        isCurrent: () => watchCurrent(watch) && selected.lease.isCurrent(), releaseObservation: captured.release });
                    adoptedHandles.set(watch.watchId, established);
                } catch (error) {
                    preserveUnconfirmedNativeProcess(error);
                    // Saved intent stays visible as unknown; no failed or healthy native fact is invented.
                }
            }
            reconciled = intent;
            registry = lease.registry;
        } finally { await lease.release(); }
    }
    async function reconcile(serviceId?: string): Promise<void> {
        if (reconciliation) { await reconciliation; return reconcile(serviceId); }
        const pending = reconcileCurrent(serviceId);
        reconciliation = pending;
        try { await pending; }
        finally { if (reconciliation === pending) reconciliation = undefined; }
    }
    async function projectServices(request: Invocation, serviceId?: string, environmentId?: string): Promise<Readonly<{
        rows: MachineServiceRowV1[]; handles: ServiceHandle[];
    }> | null> {
        await ensureEnvironmentServices();
        if (!environmentId) await reconcile(serviceId);
        const intent = environmentId ? null : readIntent();
        if (!environmentId && !intent) return null;
        const selected = serviceId ? intent?.byId.get(serviceId) : undefined;
        const watches = environmentId ? [] : serviceId ? selected ? [selected] : [] : intent!.watches.watches;
        const lease = tryAcquireAuthoritativePluginRuntimeRegistryLease();
        if (!lease) return intent?.watches.watches.length ? { rows: watches.map(rows.unknown), handles: [] } : null;
        try {
            const owner = lease.registry.projectManagedServices;
            const handles: ServiceHandle[] = [];
            const projects = owner.listProjectServices();
            handles.push(...await selectVisibleMachineProjectServices(target, environmentId
                ? projects.filter(handle => handle.kind === 'environment' && handle.environmentId === environmentId) : projects, request, serviceId));
            const readRow = async (handle: ServiceHandle) => {
                // An explicit list read samples existing native accounting; observation itself never polls.
                if (request.actionId === 'machines.services.list' && !request.context.machineServicesListResource && handle.readAccounting) {
                    await accounting(handle, request.signal);
                }
                return owner.machineServiceRows.read(handle);
            };
            const projectedRows = await Promise.all(handles.map(readRow));
            if (environmentId) return { rows: projectedRows, handles };
            const current = readIntent();
            if (!current) return null;
            const demanded = serviceId ? current.byId.get(serviceId) : undefined;
            for (const watch of serviceId ? demanded ? [demanded] : [] : current.watches.watches) {
                const incumbent = owner.resolveNativeService(watch, target);
                if (incumbent && incumbent.authority !== 'machine' && incumbent.handle !== null) continue;
                const candidate = registry === lease.registry ? adoptedHandles.get(watch.watchId) : undefined;
                const handle = candidate && sameWatch(candidate.watch, watch) && candidate.isCurrent()
                    && !candidate.retirementSignal.aborted ? candidate : undefined;
                projectedRows.push(handle ? await readRow(handle) : rows.unknown(watch));
                if (handle) handles.push(handle);
            }
            return { rows: projectedRows, handles };
        } finally { await lease.release(); }
    }
    async function discover(registry: ResolvedExecutablePluginRuntimeRegistry, adapter?: PluginContributionIdentityV1,
        signal?: AbortSignal): Promise<Extract<MachineServicesDiscoveryResultV1, { kind: 'snapshot' }>> {
        const references = adapter ? [adapter] : registry.contributes.activationTargets.flatMap(target =>
            target.manifest.contributes.projectNativeAdapters.filter(declaration => declaration.roles.includes('nativeServiceLifecycle'))
                .map(declaration => ({ pluginId: target.pluginId, localId: declaration.id })));
        const candidates: MachineServiceDiscoveryCandidateV1[] = [];
        const failures: Extract<MachineServicesDiscoveryResultV1, { kind: 'snapshot' }>['failures'] = [];
        for (const reference of references) {
            signal?.throwIfAborted();
            try {
                const selected = await registry.resolveProjectNativeAdapter(reference, 'nativeServiceLifecycle');
                if (selected.kind !== 'ready') { failures.push({ adapter: reference, code: selected.code }); continue; }
                const captured = selected.lease.captureNativeServiceLifecycle(null, { machine: target, ...(signal ? { signal } : {}) });
                if (captured.kind !== 'ready') { failures.push({ adapter: reference, code: captured.code }); continue; }
                try {
                    if (!captured.lifecycle.discover) { failures.push({ adapter: reference, code: 'native_adapter_unsupported' }); continue; }
                    const result = await captured.lifecycle.discover(target, signal ? { signal } : undefined);
                    if (result.kind !== 'ready' && result.kind !== 'partial') { failures.push({ adapter: reference, code: (result as Extract<typeof result, { code: string }>).code }); continue; }
                    for (const candidate of result.candidates) {
                        const incumbent = registry.projectManagedServices.resolveNativeService(candidate.instance, target);
                        if (incumbent && incumbent.authority !== 'machine') continue;
                        candidates.push(MachineServiceDiscoveryCandidateV1Schema.parse({
                            candidateId: machineServiceNativeIdentityKeyV1(candidate.instance),
                            revision: revision([machineServiceNativeIdentityKeyV1(candidate.instance), candidate.name]),
                            name: candidate.name, ...candidate.instance, observation: candidate.observation,
                        }));
                    }
                    failures.push(...result.failures.map(failure => ({ adapter: reference, code: failure.code })));
                } finally { await captured.release(); }
            } catch (error) {
                preserveUnconfirmedNativeProcess(error);
                signal?.throwIfAborted();
                failures.push({ adapter: reference, code: 'native_adapter_unavailable' });
            }
        }
        return { kind: 'snapshot', candidates, failures };
    }
    async function accounting(handle: ServiceHandle, signal?: AbortSignal): Promise<MachineServiceAccountingV1> {
        if (!handle.readAccounting) return unavailable('unsupported');
        try {
            const result = await handle.readAccounting(signal ? { signal } : undefined);
            if (result.kind !== 'sample') return unavailable(result.kind === 'unsupported' ? 'unsupported' : result.kind === 'cancelled' ? 'cancelled' : 'unavailable');
            const samples = result.samples.map(sample => {
                if ('instance' in sample) {
                    if (handle.kind !== 'adopted' || machineServiceNativeIdentityKeyV1(sample.instance) !== machineServiceNativeIdentityKeyV1(handle.instance)) {
                        throw new Error('Native accounting capture mismatch');
                    }
                    return { nativeResourceId: sample.instance.nativeResourceId, cpuPercent: sample.cpuPercent, memoryBytes: sample.memoryBytes };
                }
                return sample;
            });
            return MachineServiceAccountingV1Schema.parse({ kind: 'sample', samples });
        } catch (error) {
            preserveUnconfirmedNativeProcess(error);
            return unavailable(signal?.aborted ? 'cancelled' : 'unavailable');
        }
    }
    async function execute(request: Invocation): Promise<MachineServiceActionOutput | ActionExecuteFailure> {
        if (disposed) return unavailable();
        const parsed = MACHINE_SERVICE_ACTION_INPUT_SCHEMAS[request.actionId].safeParse(request.input);
        if (!parsed.success) return unavailable('denied');
        try {
            // One admitted transport/content basis for the entire mutation, including discovery.
            const metadataPort = request.actionId === 'machines.services.watch' || request.actionId === 'machines.services.unwatch'
                ? input.captureMetadataPort() : null;
            if (parsed.data.machineId !== target.machineId || !await isServerProfileHomeIdentity(target.serverId, parsed.data.serverId)) return unavailable('denied');
            request.signal?.throwIfAborted();
            let result: MachineServiceActionOutput;
            if (request.actionId === 'machines.services.list' || request.actionId === 'machines.services.detail') {
                const serviceId = 'serviceId' in parsed.data ? parsed.data.serviceId : undefined;
                const environmentId = 'environmentId' in parsed.data ? parsed.data.environmentId : undefined;
                const projection = await projectServices(request, serviceId, environmentId);
                if (!projection) return unavailable();
                if (request.actionId === 'machines.services.list') result = { kind: 'snapshot', services: projection.rows };
                else {
                    const service = projection.rows.find(row => row.serviceId === serviceId);
                    const expectedGeneration = 'expectedGeneration' in parsed.data ? parsed.data.expectedGeneration : undefined;
                    if (!service || expectedGeneration && service.generation !== expectedGeneration) return unavailable('unavailable');
                    const handle = projection.handles.find(candidate => candidate.serviceId === serviceId);
                    result = { kind: 'service', service, accounting: handle ? await accounting(handle, request.signal) : unavailable(),
                        ...(handle && handle.readNativeRuntimeFacts
                            ? { runtimeFacts: handle.readNativeRuntimeFacts() } : {}) };
                }
            } else if (request.actionId === 'machines.services.unwatch' && 'watchId' in parsed.data) {
                const port = metadataPort;
                if (!port) return unavailable();
                const current = await getMachineServiceWatchesV1(port);
                if (current.status !== 'ready') return unavailable();
                const unwatchInput = parsed.data;
                const watch = current.policy.watches.find(watch => watch.watchId === unwatchInput.watchId);
                if (!watch) { await reconcile(); return { kind: 'unchanged', revision: revision(current.policy) }; }
                if (revision(watch) !== unwatchInput.expectedRevision) return { kind: 'conflict', revision: revision(watch), watch };
                const mutation = await mutateMachineServiceWatchesV1({ expectedMetadataVersion: current.metadataVersion, expectedWatches: current.policy,
                    watches: { v: 1, watches: current.policy.watches.filter(candidate => candidate.watchId !== watch.watchId) } }, port,
                request.signal ? { signal: request.signal } : undefined);
                if (!('policy' in mutation)) return unavailable(mutation.status === 'cancelled' ? 'cancelled' : 'admission_unavailable');
                result = { kind: mutation.status === 'conflict' ? 'conflict' : mutation.status === 'applied' ? 'applied' : 'unchanged', revision: revision(mutation.policy) };
                await reconcile();
            } else {
                const lease = tryAcquireAuthoritativePluginRuntimeRegistryLease();
                if (!lease) return unavailable();
                try {
                    if (request.actionId === 'machines.services.discovery') result = await discover(lease.registry,
                        'adapter' in parsed.data ? parsed.data.adapter : undefined, request.signal);
                    else if ('candidateId' in parsed.data) {
                        const watchInput = parsed.data;
                        let identity: unknown;
                        try { identity = JSON.parse(watchInput.candidateId); } catch { return unavailable('unavailable'); }
                        if (!Array.isArray(identity) || identity.length !== 3) return unavailable('unavailable');
                        const adapter = MachineServiceWatchV1Schema.shape.adapter.safeParse({ pluginId: identity[0], localId: identity[1] });
                        const nativeResourceId = MachineServiceWatchV1Schema.shape.nativeResourceId.safeParse(identity[2]);
                        if (!adapter.success || !nativeResourceId.success) return unavailable('unavailable');
                        const instance = { adapter: adapter.data, nativeResourceId: nativeResourceId.data };
                        if (machineServiceNativeIdentityKeyV1(instance) !== watchInput.candidateId) return unavailable('unavailable');
                        const discovery = await discover(lease.registry, adapter.data, request.signal);
                        const candidate = discovery.candidates.find(candidate => candidate.candidateId === watchInput.candidateId);
                        if (!candidate) return unavailable('unavailable');
                        if (candidate.revision !== watchInput.expectedRevision) return { kind: 'conflict', revision: candidate.revision };
                        const port = metadataPort;
                        if (!port) return unavailable();
                        const current = await getMachineServiceWatchesV1(port);
                        if (current.status !== 'ready') return unavailable();
                        const incumbent = lease.registry.projectManagedServices.resolveNativeService(instance, target);
                        if (incumbent && incumbent.authority !== 'machine') return unavailable('denied');
                        const existing = current.policy.watches.find(watch => machineServiceNativeIdentityKeyV1(watch) === candidate.candidateId);
                        if (existing) { await reconcile(); return { kind: 'unchanged', revision: revision(existing), watch: existing }; }
                        if (incumbent) return unavailable('denied');
                        const watch = MachineServiceWatchV1Schema.parse({ v: 1, watchId: randomUUID(), name: candidate.name,
                            ...instance, lifecyclePurpose: watchInput.lifecyclePurpose });
                        const mutation = await mutateMachineServiceWatchesV1({ expectedMetadataVersion: current.metadataVersion,
                            expectedWatches: current.policy, watches: { v: 1, watches: [...current.policy.watches, watch] } }, port,
                        request.signal ? { signal: request.signal } : undefined);
                        if (!('policy' in mutation)) return unavailable(mutation.status === 'cancelled' ? 'cancelled' : 'admission_unavailable');
                        const actual = mutation.policy.watches.find(candidate => machineServiceNativeIdentityKeyV1(candidate) === watchInput.candidateId);
                        result = { kind: mutation.status === 'conflict' ? 'conflict' : mutation.status === 'applied' ? 'applied' : 'unchanged',
                            revision: actual ? revision(actual) : revision(mutation.policy), ...(actual ? { watch: actual } : {}) };
                    } else return unavailable('denied');
                } finally { await lease.release(); }
                if (request.actionId === 'machines.services.watch') await reconcile();
            }
            // Validate without replacing the canonical in-process row identities.
            MACHINE_SERVICE_ACTION_OUTPUT_SCHEMAS[request.actionId].parse(result);
            return result;
        } catch (error) {
            preserveUnconfirmedNativeProcess(error);
            const failure = ActionExecuteFailureSchema.safeParse(error);
            if (failure.success) return failure.data;
            return unavailable(request.signal?.aborted ? 'cancelled' : 'admission_unavailable');
        }
    }
    async function ensureEnvironmentServices(): Promise<void> {
        if (!input.restoreEnvironmentServices || disposed) return;
        const lease = tryAcquireAuthoritativePluginRuntimeRegistryLease();
        if (!lease) return;
        try {
            const owner = lease.registry.projectManagedServices;
            await owner.restoreEnvironmentServices(target, () => input.restoreEnvironmentServices!(owner, lifetime.signal), lifetime.signal);
        } finally { await lease.release(); }
    }
    return { execute, reconcile, ensureEnvironmentServices, async dispose() {
        if (disposed) return;
        disposed = true;
        lifetime.abort('Machine service observations detached');
        const lease = tryAcquireAuthoritativePluginRuntimeRegistryLease();
        if (!lease) return;
        try { await lease.registry.projectManagedServices.retireMachineServices(target); }
        finally { await lease.release(); }
    } };
}
