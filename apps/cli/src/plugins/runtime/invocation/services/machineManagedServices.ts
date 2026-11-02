import { PluginError } from '@happier-dev/plugin-sdk';
import { resolveServerProfileHomeIdentityId } from '@/server/serverProfiles';
import { MachineServiceWatchV1Schema, MachineServiceWatchesFieldV1, machineServiceNativeIdentityKeyV1,
    type MachineServiceWatchV1, type ManagedServiceNativeLogResultV1, type MachineServiceNativeRuntimeFactsV1 } from '@happier-dev/protocol';
import type { ManagedServiceHandle, ManagedServiceNativeInstanceV1, ManagedServiceNativeLifecycleV1,
    ManagedServiceSnapshot, ManagedServiceNativeObservationV1 } from '@happier-dev/plugin-sdk/managed-services';
import type { MachineNativeEffectKey, MachineNativeEffectOperation } from '@/daemon/local/services/launch/machineNativeEffectAdmission';
import { runManagedServiceNativeControl, type ManagedServiceNativeControlResult } from './managedServiceNativeControl';
import { invalidateProcessLaunchDiscovery } from '@/processes/launchNotification';
import { MANAGED_SERVICE_NUMERIC_CONTRACT } from './managedServiceSpecNormalization';
import { createManagedServiceAccountingRead } from './managedServiceAccountingRead';
import type { ManagedServiceProcessHandle, ManagedServiceProcessHealthSnapshot,
    ManagedServiceProcessSupervisorHost, ProjectBuiltinNativeLifecycle } from './managedProcessSupervisor';
import type { ManagedServiceSemanticEntry, ManagedServicesSemanticEntry, ManagedServiceHandleWrapper } from './managedServicesOwner';
import type { ManagedServiceNativeLogReadOptionsForHost } from './managedServiceNativeLogs';

export type MachineManagedServiceHandle = ManagedServiceHandle & Readonly<{
    kind: 'adopted';
    homeServerIdentityId?: string | null;
    serverId: string;
    machineId: string;
    serviceId: string;
    watch: MachineServiceWatchV1;
    instance: ManagedServiceNativeInstanceV1;
    instanceId: string;
    endpointKind: 'native';
    lifecyclePurpose: MachineServiceWatchV1['lifecyclePurpose'];
    actionScope: Readonly<{ kind: 'machine'; machineId: string }>;
    capabilities: Readonly<{ start: boolean; stop: boolean; restart: boolean; logs: boolean; accounting: boolean }>;
    retirementSignal: AbortSignal;
    isCurrent(): boolean;
    isServing(): boolean;
    inspectCurrentOccurrence(): Promise<ManagedServiceSnapshot>;
    controlNative(operation: 'start' | 'stop' | 'restart', options: Readonly<{
        operation: MachineNativeEffectOperation; signal?: AbortSignal;
    }>): Promise<ManagedServiceNativeControlResult>;
    observeHealth(listener: (snapshot: ManagedServiceProcessHealthSnapshot) => void): Readonly<{ dispose(): void }>;
    readHealthSnapshot?(): ManagedServiceProcessHealthSnapshot;
    readNativeRuntimeFacts(): MachineServiceNativeRuntimeFactsV1;
    readLogs(options?: ManagedServiceNativeLogReadOptionsForHost): Promise<ManagedServiceNativeLogResultV1>;
    watchLogs: NonNullable<ManagedServiceProcessHandle['watchNativeLogs']>;
    readAccounting?(options?: Readonly<{ signal?: AbortSignal }>): ReturnType<NonNullable<ManagedServiceNativeLifecycleV1['accounting']>>;
}>;

export type MachineManagedServiceSupervisionInput = Readonly<{
    serverId: string;
    machineId: string;
    watch: MachineServiceWatchV1;
    /** Captured by the admitted projectNativeAdapters owner, including invocation context. */
    lifecycle: ManagedServiceNativeLifecycleV1;
    signal?: AbortSignal;
    isCurrent(): boolean;
    releaseObservation(): Promise<void>;
    /** Exact native coordinates come from the host capture, never from a watch or caller. */
    nativeEffects?: Readonly<{ keys: readonly MachineNativeEffectKey[]; settleNative?: () => Promise<void> }>;
}>;

export type ManagedNativeServiceReference = Readonly<{
    authority: 'machine' | 'project' | 'plugin';
    serviceId: string;
    handle: ManagedServiceHandle | null;
}>;

type MachineEntry = Extract<ManagedServiceSemanticEntry, { authority: 'machine' }>;
type MachineTarget = Readonly<{ serverId: string; machineId: string }>;

function unavailable(): never {
    throw new PluginError({ code: 'plugin_managed_service_unavailable', message: 'Adopted service admission is unavailable' });
}

function sameWatch(left: MachineServiceWatchV1, right: MachineServiceWatchV1): boolean {
    return MachineServiceWatchesFieldV1.equal({ v: 1, watches: [left] }, { v: 1, watches: [right] });
}

/** Machine observation uses the incumbent semantic entries and supervisor. This
 * module owns no registry, native launcher, timer, snapshot store or custody map. */
export function createMachineManagedServices(input: Readonly<{
    entries: Map<string, ManagedServicesSemanticEntry>;
    supervisorHost(): ManagedServiceProcessSupervisorHost;
    isRetired(): boolean;
    wrapHandle: ManagedServiceHandleWrapper;
    waitForEstablishment(entry: ManagedServiceSemanticEntry, signal?: AbortSignal): Promise<ManagedServiceHandle>;
    retireEntry(entry: ManagedServiceSemanticEntry): Promise<void>;
    removeEntry(entry: ManagedServicesSemanticEntry): void;
    observeProcess(entry: ManagedServiceSemanticEntry, process: ManagedServiceProcessHandle): void;
    notifyActivity(): void;
    publishServiceRow(handle: MachineManagedServiceHandle): void;
    retireServiceRow(handle: MachineManagedServiceHandle): void;
    resolveNativeService(instance: ManagedServiceNativeInstanceV1, target: MachineTarget): ManagedNativeServiceReference | null;
}>) {
    const entries = (): MachineEntry[] => [...input.entries.values()].filter((entry): entry is MachineEntry => (
        entry.kind === 'service' && entry.authority === 'machine'
    ));
    const listMachineServices = (): readonly MachineManagedServiceHandle[] => Object.freeze(entries()
        .flatMap(entry => entry.machine.handle ? [entry.machine.handle] : []));
    const retireMachineServices = async (target: MachineTarget & Readonly<{ retainWatches?: readonly MachineServiceWatchV1[] }>): Promise<void> => {
        const retained = new Map(target.retainWatches?.map(watch => [watch.watchId, watch] as const));
        const results = await Promise.allSettled(entries().filter(entry => {
            if (entry.machine.serverId !== target.serverId || entry.machine.machineId !== target.machineId) return false;
            const watch = retained.get(entry.machine.watch.watchId);
            return !watch || !sameWatch(watch, entry.machine.watch);
        }).map(input.retireEntry));
        const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
        if (failures.length) throw new AggregateError(failures, 'Failed to detach adopted service observation');
    };
    const superviseMachine = async (request: MachineManagedServiceSupervisionInput): Promise<MachineManagedServiceHandle> => {
        let observationTransferred = false;
        let released: Promise<void> | undefined;
        const releaseObservation = () => released ??= Promise.resolve().then(request.releaseObservation);
        try {
            if (input.isRetired() || input.supervisorHost().custodyOwner !== 'daemon'
                || !request.serverId.trim() || !request.machineId.trim() || !request.isCurrent()) unavailable();
            if (request.signal?.aborted) throw new PluginError({ code: 'plugin_operation_aborted', message: 'Service observation was aborted' });
            const watch = Object.freeze(MachineServiceWatchV1Schema.parse(request.watch));
            const instance = Object.freeze({ adapter: Object.freeze({ ...watch.adapter }), nativeResourceId: watch.nativeResourceId });
            const entryKey = JSON.stringify(['machine-service', request.serverId, request.machineId, watch.watchId]);
            const existing = input.entries.get(entryKey);
            if (existing) {
                if (existing.kind !== 'service' || existing.authority !== 'machine') unavailable();
                if (existing.terminal || existing.establishmentAbort.signal.aborted || !existing.scope.isOccurrenceCurrent()
                    || !sameWatch(existing.machine.watch, watch)) {
                    await input.retireEntry(existing);
                    observationTransferred = true;
                    return await superviseMachine(request);
                }
                observationTransferred = existing.observationRelease === request.releaseObservation;
                await input.waitForEstablishment(existing, request.signal);
                if (!existing.machine.handle || !request.isCurrent()) unavailable();
                if (!observationTransferred) await releaseObservation();
                return existing.machine.handle;
            }
            const nativeOwner = input.resolveNativeService(instance, request);
            if (nativeOwner) {
                const incumbent = entries().find(entry => entry.machine.serverId === request.serverId
                    && entry.machine.machineId === request.machineId
                    && machineServiceNativeIdentityKeyV1(entry.machine.instance) === machineServiceNativeIdentityKeyV1(instance));
                if (!incumbent) throw new PluginError({ code: 'plugin_managed_service_spec_conflict', message: 'Native service already has an admitted owner' });
                if (incumbent.terminal || incumbent.establishmentAbort.signal.aborted || !incumbent.scope.isOccurrenceCurrent()) {
                    await input.retireEntry(incumbent);
                    observationTransferred = true;
                    return await superviseMachine(request);
                }
                observationTransferred = incumbent.observationRelease === request.releaseObservation;
                await input.waitForEstablishment(incumbent, request.signal);
                if (!incumbent.machine.handle || !request.isCurrent()) unavailable();
                if (!observationTransferred) await releaseObservation();
                return incumbent.machine.handle;
            }
            const lifetime = new AbortController();
            const isCurrent = () => !input.isRetired() && !lifetime.signal.aborted && request.isCurrent();
            const assertCurrent = () => { if (!isCurrent()) unavailable(); };
            const entry: MachineEntry = {
                kind: 'service', authority: 'machine', effectiveOwnerKey: entryKey,
                lifecycle: { kind: 'machine', identity: entryKey, retainedAcrossOrdinaryGenerationRetirement: false },
                scope: { signal: lifetime.signal, isOccurrenceCurrent: isCurrent },
                specIdentity: JSON.stringify(watch), establishmentAbort: lifetime,
                machine: { serverId: request.serverId, machineId: request.machineId, watch, instance, handle: null },
                nativeInstances: [instance], nativeServiceId: watch.watchId,
                establishment: Promise.resolve(null as never), establishmentSettled: false, waiterCount: 0,
                terminal: false, processHandle: null, readProcessSnapshot: null,
                establishmentCleanup: null, credentialCleanup: null, retirement: null, observationRelease: request.releaseObservation,
            };
            const native = request.lifecycle;
            let runtimeFacts: MachineServiceNativeRuntimeFactsV1 = { configuration: null, observedAt: null, freshness: 'unavailable' };
            const retainObservation = (observation: ManagedServiceNativeObservationV1) => {
                runtimeFacts = observation.phase === 'unknown'
                    ? { configuration: null, observedAt: null, freshness: 'unavailable' }
                    : { configuration: null, observedAt: Date.now(), freshness: 'current',
                        ...(observation.accounting ? { accounting: observation.accounting } : {}),
                        ...(observation.healthSince !== undefined ? { healthSince: observation.healthSince } : {}),
                    };
                return observation;
            };
            const control = async (operation: 'start' | 'restart', options?: Readonly<{ signal?: AbortSignal }>) => {
                assertCurrent();
                const method = native[operation];
                if (!method) unavailable();
                const result = await method.call(native, instance, options);
                if ('kind' in result) throw new PluginError({ code: result.code, message: 'Native service control was refused' });
                return retainObservation(result);
            };
            const lifecycle: ProjectBuiltinNativeLifecycle = {
                async inspect(options) {
                    assertCurrent();
                    try {
                        const result = await native.inspect(instance, options);
                        assertCurrent();
                        return retainObservation(result);
                    } catch (error) {
                        runtimeFacts = { configuration: null, observedAt: null, freshness: 'unavailable' };
                        throw error;
                    }
                },
                async stop(options) {
                    const result = await native.stop(instance, options);
                    // The confirmed stop is the existing witness; no extra native read.
                    if (result.status === 'stopped') retainObservation({ phase: 'stopped', readiness: 'not_reported', endpoint: null });
                    return result;
                },
                ...(native.start ? { start: (options?: Readonly<{ signal?: AbortSignal }>) => control('start', options) } : {}),
                ...(native.restart ? { restart: (options?: Readonly<{ signal?: AbortSignal }>) => control('restart', options) } : {}),
                ...(native.logs ? { logs: (options: Parameters<NonNullable<ProjectBuiltinNativeLifecycle['logs']>>[0]) => {
                    if (options.kind === 'watch') return native.logs!(instance, options);
                    const { allowIncompleteSecretMasking: _allowIncompleteSecretMasking, ...pluginRequest } = options;
                    return native.logs!(instance, pluginRequest);
                } } : {}),
            };
            observationTransferred = true;
            // Publish pending admission synchronously before the first native await.
            input.entries.set(entryKey, entry);
            entry.establishment = (async () => {
                const homeServerIdentityId = await resolveServerProfileHomeIdentityId(request.serverId);
                assertCurrent();
                const process = await input.supervisorHost().bind({ kind: 'machine', isOccurrenceCurrent: isCurrent }).supervise({
                    id: watch.watchId,
                    mode: { kind: 'native', builtinLifecycle: lifecycle, observationOnly: true, releaseObservation },
                    watchdog: { intervalMs: MANAGED_SERVICE_NUMERIC_CONTRACT.healthIntervalMs.defaultValue,
                        missedIntervals: MANAGED_SERVICE_NUMERIC_CONTRACT.consecutiveFailures.defaultValue },
                }, { signal: lifetime.signal, registerEstablishmentCleanup(cleanup, observation) {
                    entry.establishmentCleanup = cleanup;
                    entry.readProcessSnapshot = observation.snapshot;
                    entry.readAcquiredCustody = observation.hasAcquiredCustody;
                    return { release() { if (entry.establishmentCleanup === cleanup) entry.establishmentCleanup = null; } };
                } });
                entry.processHandle = process;
                entry.readProcessSnapshot = () => process.snapshot();
                input.observeProcess(entry, process);
                entry.establishmentCleanup = null;
                try { assertCurrent(); } catch (error) { await process.dispose(); entry.processHandle = null; throw error; }
                const wrapped = input.wrapHandle(process, async () => {}, { status: 'detached' }, undefined,
                    async () => unavailable(), lifetime.signal, () => { entry.terminal = true; }, () => {
                        lifetime.abort('Adopted observation detached'); input.removeEntry(entry);
                    }, false, true);
                const accounting = native.accounting ? createManagedServiceAccountingRead(async signal => {
                    assertCurrent();
                    const result = await native.accounting!([instance], { signal: AbortSignal.any([lifetime.signal, signal]) });
                    assertCurrent();
                    return result;
                }) : undefined;
                const handle = Object.freeze<MachineManagedServiceHandle>({
                    homeServerIdentityId,
                    ...wrapped, kind: 'adopted', serverId: request.serverId, machineId: request.machineId,
                    watch, instance, serviceId: watch.watchId, instanceId: process.snapshot().instanceId, endpointKind: 'native',
                    lifecyclePurpose: watch.lifecyclePurpose, actionScope: { kind: 'machine', machineId: request.machineId },
                    capabilities: Object.freeze({ start: Boolean(native.start), stop: true, restart: Boolean(native.restart),
                        logs: Boolean(native.logs), accounting: Boolean(native.accounting) }),
                    retirementSignal: lifetime.signal, isCurrent,
                    async inspectCurrentOccurrence() { assertCurrent(); if (!process.inspectCurrentOccurrence) unavailable();
                        await process.inspectCurrentOccurrence(); assertCurrent(); return wrapped.snapshot(); },
                    observeHealth(listener) { assertCurrent(); if (!process.observeHealth) unavailable(); return process.observeHealth(listener); },
                    readHealthSnapshot: () => process.snapshot(),
                    readNativeRuntimeFacts: () => runtimeFacts,
                    async readLogs(options) { assertCurrent();
                        const result = process.readNativeLogs ? await process.readNativeLogs(options) : { kind: 'unavailable' as const, reason: 'unsupported' as const };
                        assertCurrent(); return result;
                    },
                    async watchLogs(options) {
                        assertCurrent();
                        if (!process.watchNativeLogs) return unavailable();
                        const subscription = await process.watchNativeLogs({ ...options,
                            signal: AbortSignal.any([lifetime.signal, ...(options.signal ? [options.signal] : [])]),
                            emit(result) { if (isCurrent()) options.emit(result); },
                        });
                        try { assertCurrent(); }
                        catch (error) { await subscription.dispose(); throw error; }
                        return subscription;
                    },
                    ...(accounting ? { async readAccounting(options?: Readonly<{ signal?: AbortSignal }>) {
                        assertCurrent();
                        const result = await accounting.read(options);
                        assertCurrent();
                        return result;
                    } } : {}),
                    async stop() { return unavailable(); },
                    async dispose() {
                        entry.terminal = true;
                        lifetime.abort('Adopted observation detached');
                        if (entry.nativeControl) await entry.nativeControl.settlement;
                        await wrapped.dispose();
                    },
                    async controlNative(operation, options) {
                        assertCurrent();
                        if (!lifecycle[operation] || !process.controlNative) unavailable();
                        const signal = AbortSignal.any([lifetime.signal, ...(options.signal ? [options.signal] : []),
                            ...(options.operation.signal ? [options.operation.signal] : [])]);
                        return await runManagedServiceNativeControl(entry, { keys: request.nativeEffects?.keys ?? [],
                            ...(request.nativeEffects?.settleNative ? { settleNative: request.nativeEffects.settleNative } : {}),
                            operation: { ...options.operation, signal } }, async () => {
                            assertCurrent(); return await process.controlNative!(operation, { signal });
                        }, input.notifyActivity);
                    },
                });
                entry.machine.handle = handle;
                handle.retirementSignal.addEventListener('abort', () => input.retireServiceRow(handle), { once: true });
                input.publishServiceRow(handle);
                entry.processHandle = null;
                return handle;
            })().finally(() => {
                entry.establishmentSettled = true; input.notifyActivity(); invalidateProcessLaunchDiscovery();
            }).catch(async error => {
                entry.terminal = true;
                await releaseObservation();
                if (!entry.processHandle && !entry.establishmentCleanup) input.removeEntry(entry);
                throw error;
            });
            input.notifyActivity();
            await input.waitForEstablishment(entry, request.signal);
            if (!entry.machine.handle) unavailable();
            return entry.machine.handle;
        } catch (error) {
            if (!observationTransferred) await releaseObservation();
            throw error;
        }
    };
    return { superviseMachine, listMachineServices, retireMachineServices };
}
