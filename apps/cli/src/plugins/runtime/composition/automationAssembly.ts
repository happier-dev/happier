import type { StoredCredentials } from '@/persistence';
import type { ResolvedContributionRegistry } from '../../projection/registry/types';
import type { PluginSourceCustody } from '../sourceAuthority';
import { createAutomationEventAdoptedDefinitionSetHostV1 } from '../automations/automationEventAdoptedDefinitionSetHost';
import type { AutomationEventAdoptedDefinitionSetWithHistoryGapRecoveryV1 } from '../automations/automationEventAdoptedDefinitionSet';
import { arePluginMachineMaterializationRefsEqual } from '@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1';
import type { AutomationEventSourcesListTransportV1, PluginMachineMaterializationRefV1 } from '@happier-dev/protocol';
import type { WorkflowTriggerHealthSourceV1 } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';
import type { SavedHealthCheckSourceRead } from '@/deployments/healthChecks/readSavedHealthCheckSource';
import type { MachinePresenceAutomationOccurrenceV1 } from '@happier-dev/protocol/machines/machinePresenceTransitionsV1';
import { computeCanonicalDomainSeparatedDigest } from '@happier-dev/protocol/crypto/canonicalDigest';
import { createAutomationEventActionExecutor } from '../automations/automationEventActionExecutor';
import { MachinePresenceReadResultV1Schema } from '@happier-dev/protocol/machines/machineAccessV1';
import type { AutomationEventSourceDefinitionV1 } from '@happier-dev/protocol/automations/automationActionSpecsV1';

type ConsumerLifecycle = Readonly<{
    isCurrent(): boolean;
    retirementSignal: AbortSignal;
}>;

export async function assembleAutomationRuntime(input: Readonly<{
    credentials: StoredCredentials | null;
    activationTargets: ResolvedContributionRegistry['activationTargets'];
    activatedPluginIds: Pick<ReadonlySet<string>, 'has'>;
    resolveCurrentMaterialization(pluginId: string): PluginMachineMaterializationRefV1 | null;
    readPluginOccurrenceId(pluginId: string): string | null;
    readPluginSourceCustody(pluginId: string): PluginSourceCustody | null;
    resolveConsumerLifecycle(pluginId: string): ConsumerLifecycle;
    revalidateCallerMaterialization(candidate: PluginMachineMaterializationRefV1): Promise<boolean>;
    revalidateCallerOccurrence(candidate: Readonly<{ pluginId: string; occurrenceId: string }>): Promise<boolean>;
    onAdopted?(): void;
    readHealthSources?(): Promise<ReadonlyMap<string, WorkflowTriggerHealthSourceV1>>;
    readNativePresence?(definition: AutomationEventSourceDefinitionV1,
        target: Readonly<{ serverId: string; machineId: string }>, signal: AbortSignal): Promise<unknown>;
}>) {
    // Native controllers also consume sources assigned to another observer.
    // The existing definitions invalidation retires this same assembly's view;
    // the next admission borrows one refresh, with no idle or per-arrival scan.
    let healthSources: Promise<ReadonlyMap<string, WorkflowTriggerHealthSourceV1> | Readonly<{ kind: 'unavailable'; code: string; cause?: unknown }>> | null = null;
    const readHealthAlertSource = async (sourceInstanceId: string): Promise<SavedHealthCheckSourceRead> => {
        if (!input.readHealthSources) return { kind: 'unavailable', code: 'health_check_source_unavailable' };
        const current = await (healthSources ??= input.readHealthSources().catch((error: unknown) => {
            if (error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
                return { kind: 'unavailable' as const, code: error.code };
            }
            // A malformed remote response must not suppress the native Inbox
            // transition. Keep the cause in-process; consumers disclose only code.
            return { kind: 'unavailable' as const, code: 'internal_error', cause: error };
        }));
        if ('kind' in current) return current;
        const source = current.get(sourceInstanceId);
        return source ? { kind: 'available', ...source } : { kind: 'unconfigured' };
    };
    const adoptedOwners: Array<Readonly<{
        caller: PluginMachineMaterializationRefV1;
        occurrenceId: string;
        transport: AutomationEventSourcesListTransportV1;
        owner: AutomationEventAdoptedDefinitionSetWithHistoryGapRecoveryV1;
    }>> = [];
    async function refreshActivatedPlugin(pluginId?: string): Promise<void> {
        const credentials = input.credentials;
        if (!credentials) return;
        const sourceTargets = input.activationTargets.filter((target) => (
            (pluginId === undefined || target.pluginId === pluginId)
            && input.activatedPluginIds.has(target.pluginId)
            && (target.manifest.contributes.events ?? []).some((event) => (
                event.kind === 'event'
                && event.automation?.eligible === true
                && event.automation.source.supportedObservationTransports.some((transport) => (
                    transport === 'checkpointedPull' || transport === 'durablePush' || transport === 'socket'
                ))
            ))
        ));
        for (const target of sourceTargets) {
            const caller = input.resolveCurrentMaterialization(target.pluginId);
            const occurrenceId = input.readPluginOccurrenceId(target.pluginId);
            const sourceCustody = input.readPluginSourceCustody(target.pluginId);
            if (!caller || !occurrenceId || !sourceCustody) continue;
            const lifecycle = input.resolveConsumerLifecycle(target.pluginId);
            const transportKinds = new Set<'checkpointedPull' | 'durablePush' | 'socket'>();
            for (const event of target.manifest.contributes.events ?? []) {
                if (event.kind !== 'event' || event.automation?.eligible !== true) continue;
                for (const transport of event.automation.source.supportedObservationTransports) {
                    transportKinds.add(transport);
                }
            }
            for (const transportKind of transportKinds) {
                if (adoptedOwners.some(candidate => (
                    candidate.occurrenceId === occurrenceId
                    && candidate.transport.kind === transportKind
                    && arePluginMachineMaterializationRefsEqual(candidate.caller, caller)
                ))) continue;
                const transport: AutomationEventSourcesListTransportV1 = transportKind === 'checkpointedPull'
                    ? { kind: 'checkpointedPull' }
                    : transportKind === 'socket'
                        ? { kind: 'socket' }
                        : { kind: 'durablePush' };
                const owner = createAutomationEventAdoptedDefinitionSetHostV1({
                    credentials,
                    caller,
                    occurrenceId,
                    sourceCustody,
                    transport,
                    occurrenceSignal: lifecycle.retirementSignal,
                    isOccurrenceCurrent: () => {
                        const current = input.resolveCurrentMaterialization(target.pluginId);
                        return lifecycle.isCurrent()
                            && current !== null
                            && arePluginMachineMaterializationRefsEqual(current, caller);
                    },
                    revalidateCallerMaterialization: input.revalidateCallerMaterialization,
                    revalidateCallerOccurrence: input.revalidateCallerOccurrence,
                    onAdopted: input.onAdopted,
                });
                const adopted = Object.freeze({ caller, occurrenceId, transport, owner });
                adoptedOwners.push(adopted);
                await owner.reconcileCatalog(lifecycle.retirementSignal);
                await reportNativePresenceObservation(adopted);
            }
        }
        await assembly.replayMachinePresence(pluginId === undefined ? undefined : [pluginId]);
    }
    // The resolver belongs to this assembly, not its initial active snapshot.
    // A dormant source can gain its existing owner before its service starts.
    const resolveAdoptedDefinitionSet = (
        caller: PluginMachineMaterializationRefV1,
        occurrenceId: string,
        transport: AutomationEventSourcesListTransportV1,
    ): AutomationEventAdoptedDefinitionSetWithHistoryGapRecoveryV1 | null => {
        const current = input.resolveCurrentMaterialization(caller.pluginId);
        if (current === null || !arePluginMachineMaterializationRefsEqual(current, caller)) return null;
        return adoptedOwners.find((candidate) => (
            arePluginMachineMaterializationRefsEqual(candidate.caller, caller)
            && candidate.occurrenceId === occurrenceId
            && candidate.transport.kind === transport.kind
        ))?.owner ?? null;
    };
    const resolveHistoryGapSource = async (request: Readonly<{
        pluginId: string;
        eventLocalIds: readonly string[];
        reset: import('@happier-dev/protocol').PluginEventAutomationHistoryGapResetActionInputV1;
        signal: AbortSignal;
        isCurrent(): boolean;
    }>) => {
        request.signal.throwIfAborted();
        if (!request.isCurrent()) return null;
        const caller = input.resolveCurrentMaterialization(request.pluginId);
        const occurrenceId = input.readPluginOccurrenceId(request.pluginId);
        if (!caller || !occurrenceId) return null;
        const owner = resolveAdoptedDefinitionSet(caller, occurrenceId, { kind: 'checkpointedPull' });
        if (!owner) return null;
        const definition = await owner.readCurrentCheckpointedPullSource({
            reset: request.reset,
            signal: request.signal,
        });
        request.signal.throwIfAborted();
        const currentCaller = input.resolveCurrentMaterialization(request.pluginId);
        if (
            definition === null
            || !request.isCurrent()
            || currentCaller === null
            || !arePluginMachineMaterializationRefsEqual(caller, currentCaller)
            || definition.eventRef.pluginId !== request.pluginId
            || !request.eventLocalIds.includes(definition.eventRef.localId)
        ) return null;
        return Object.freeze({
            eventLocalId: definition.eventRef.localId,
            sourceConfig: structuredClone(definition.sourceConfig),
        });
    };
    const nativeEventAdmission = input.credentials ? createAutomationEventActionExecutor({
        credentials: input.credentials,
        revalidateCallerMaterialization: input.revalidateCallerMaterialization,
        revalidateCallerOccurrence: input.revalidateCallerOccurrence,
        resolveAdoptedDefinitionSet,
    }) : null;
    async function reportNativePresenceObservation(entry: (typeof adoptedOwners)[number]): Promise<void> {
        if (!nativeEventAdmission || entry.caller.pluginId !== 'happier.machine.services'
            || entry.transport.kind !== 'checkpointedPull') return;
        const lifecycle = input.resolveConsumerLifecycle(entry.caller.pluginId);
        const sourceCustody = input.readPluginSourceCustody(entry.caller.pluginId);
        const projection = entry.owner.readPublicProjection();
        if (!sourceCustody || !lifecycle.isCurrent() || projection.kind !== 'available') return;
        for (const definition of projection.definitions) {
            if ((definition.eventRef.localId !== 'machine-offline' && definition.eventRef.localId !== 'machine-online')
                || definition.observationTransport.kind !== 'checkpointedPull'
                || !arePluginMachineMaterializationRefsEqual(definition.observationTransport.watcherMaterializationRef, entry.caller)) continue;
            const result = await nativeEventAdmission({ actionId: 'automation.event.source.status.report',
                caller: { kind: 'plugin', pluginId: entry.caller.pluginId, occurrenceId: entry.occurrenceId,
                    sourceCustody, materialization: entry.caller }, signal: lifecycle.retirementSignal,
                input: { kind: 'source', automationId: definition.automationId, triggerId: definition.triggerId,
                    triggerRevision: definition.triggerRevision, eventRef: definition.eventRef,
                    sourceSelectorId: definition.sourceSelectorId, state: 'observing', code: 'none',
                    nextRetryAt: null, observedDelta: 0, admittedDelta: 0, skippedDelta: 0 },
            });
            if ('ok' in result && result.ok === false) throw Object.assign(new Error(result.errorCode), { code: result.errorCode });
        }
    }
    const assembly = Object.freeze({
        /** Reconnect replays only known, demanded Machine keys. Any-Machine
         * subscriptions consume future native pushes; no inventory census. */
        async replayMachinePresence(pluginIds?: readonly string[]): Promise<void> {
            if (!input.readNativePresence || (pluginIds && !pluginIds.includes('happier.machine.services'))) return;
            const reads = new Map<string, { definition: AutomationEventSourceDefinitionV1;
                target: { serverId: string; machineId: string }; definitions: AutomationEventSourceDefinitionV1[]; signal: AbortSignal }>();
            for (const { caller, transport, owner } of adoptedOwners) {
                if (caller.pluginId !== 'happier.machine.services' || transport.kind !== 'checkpointedPull') continue;
                const projection = owner.readPublicProjection();
                if (projection.kind !== 'available') continue;
                for (const definition of projection.definitions) {
                    if (definition.eventRef.localId !== 'machine-offline' && definition.eventRef.localId !== 'machine-online') continue;
                    const config = definition.sourceConfig;
                    const selected = definition.subject?.kind === 'machine' ? definition.subject
                        : config && typeof config === 'object' && !Array.isArray(config)
                            && typeof config.serverId === 'string' && typeof config.machineId === 'string'
                            ? { serverId: config.serverId, machineId: config.machineId } : null;
                    if (!selected) continue;
                    const target = { serverId: selected.serverId, machineId: selected.machineId };
                    const key = JSON.stringify([target.serverId, target.machineId]);
                    const previous = reads.get(key);
                    if (previous) previous.definitions.push(definition);
                    else reads.set(key, { definition, target, definitions: [definition],
                        signal: input.resolveConsumerLifecycle(caller.pluginId).retirementSignal });
                }
            }
            for (const read of reads.values()) {
                const result = MachinePresenceReadResultV1Schema.parse(await input.readNativePresence(read.definition, read.target, read.signal));
                if (result.kind !== 'present') continue;
                for (const fact of result.occurrences ?? []) {
                    const eligible = new Set(read.definitions.filter(definition => {
                        const config = definition.sourceConfig;
                        return !(config && typeof config === 'object' && !Array.isArray(config)
                            && typeof config.afterRevision === 'number' && fact.revision <= config.afterRevision);
                    }).map(definition => definition.triggerId));
                    const definitions = fact.definitions.filter(selector => eligible.has(selector.triggerId));
                    if (definitions.length) await this.admitMachinePresenceOccurrences([{ ...fact, definitions }]);
                }
            }
        },
        /** Native presence owns candidate selection; the adopted private Event
         * definition owns filtering and the normal Event Action owns admission. */
        async admitMachinePresenceOccurrences(occurrences: readonly MachinePresenceAutomationOccurrenceV1[]) {
            if (!nativeEventAdmission || occurrences.length === 0) return;
            for (const { caller, occurrenceId, transport, owner } of adoptedOwners) {
                if (caller.pluginId !== 'happier.machine.services' || transport.kind !== 'checkpointedPull') continue;
                const lifecycle = input.resolveConsumerLifecycle(caller.pluginId);
                const sourceCustody = input.readPluginSourceCustody(caller.pluginId);
                if (!sourceCustody || !lifecycle.isCurrent()) continue;
                for (const fact of occurrences) {
                    const eventRef = { pluginId: caller.pluginId, localId: `machine-${fact.transition}` };
                    let projection = owner.readPublicProjection({ definitions: fact.definitions });
                    if (projection.kind === 'initializing') {
                        await owner.reconcileCatalog(lifecycle.retirementSignal);
                        projection = owner.readPublicProjection({ definitions: fact.definitions });
                    }
                    if (projection.kind !== 'available') continue;
                    const definitions = projection.definitions.filter(definition =>
                        definition.eventRef.pluginId === eventRef.pluginId && definition.eventRef.localId === eventRef.localId);
                    if (!definitions.length) continue;
                    const result = await nativeEventAdmission({ actionId: 'automation.event.admit',
                        caller: { kind: 'plugin', pluginId: caller.pluginId, occurrenceId, sourceCustody, materialization: caller },
                        signal: lifecycle.retirementSignal,
                        input: { eventRef, occurrenceId: computeCanonicalDomainSeparatedDigest('happier.machine.presence.occurrence.v1',
                            [fact.serverId, fact.machineId, fact.transition, String(fact.revision)]),
                            occurredAt: fact.occurredAt, observationReceivedAt: Date.now(),
                            payload: { serverId: fact.serverId, machineId: fact.machineId, transition: fact.transition,
                                revision: fact.revision, observedAt: fact.occurredAt },
                            subjectContexts: [{ role: 'operand', subject: { kind: 'machine', serverId: fact.serverId, machineId: fact.machineId } }],
                            definitions: definitions.map(definition => ({ automationId: definition.automationId,
                                triggerId: definition.triggerId, triggerRevision: definition.triggerRevision, sourceSelectorId: definition.sourceSelectorId })) },
                    });
                    if ('ok' in result && result.ok === false) throw Object.assign(new Error(result.errorCode), { code: result.errorCode });
                }
            }
        },
        /** Absent `pluginIds` dirties every adopted catalog; present, only those plugins'. */
        invalidateSourceDefinitions(pluginIds?: readonly string[]) {
            healthSources = null;
            for (const { caller, owner } of adoptedOwners) {
                if (pluginIds === undefined || pluginIds.includes(caller.pluginId)) owner.invalidate();
            }
        },
        async refreshSourceDefinitions(pluginIds?: readonly string[]) {
            for (const entry of adoptedOwners) {
                if (pluginIds === undefined || pluginIds.includes(entry.caller.pluginId)) {
                    await entry.owner.reconcileCatalog(input.resolveConsumerLifecycle(entry.caller.pluginId).retirementSignal);
                    await reportNativePresenceObservation(entry);
                }
            }
        },
        readHealthAlertSource,
        refreshActivatedPlugin,
        resolveAdoptedDefinitionSet,
        resolveHistoryGapSource,
    });
    await refreshActivatedPlugin();
    return assembly;
}
