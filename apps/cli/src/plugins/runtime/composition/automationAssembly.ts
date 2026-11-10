import type { StoredCredentials } from '@/persistence';
import type { ResolvedContributionRegistry } from '../../projection/registry/types';
import type { PluginSourceCustody } from '../sourceAuthority';
import { createAutomationEventAdoptedDefinitionSetHostV1 } from '../automations/automationEventAdoptedDefinitionSetHost';
import type { AutomationEventAdoptedDefinitionSetWithHistoryGapRecoveryV1 } from '../automations/automationEventAdoptedDefinitionSet';
import { arePluginMachineMaterializationRefsEqual } from '@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1';
import type { AutomationEventSourcesListTransportV1, PluginMachineMaterializationRefV1 } from '@happier-dev/protocol';
import type { WorkflowTriggerHealthSourceV1 } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';
import type { SavedHealthCheckSourceRead } from '@/deployments/healthChecks/readSavedHealthCheckSource';

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
                adoptedOwners.push(Object.freeze({ caller, occurrenceId, transport, owner }));
                await owner.refresh(lifecycle.retirementSignal);
            }
        }
    }
    await refreshActivatedPlugin();
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
    return Object.freeze({
        invalidateSourceDefinitions() {
            healthSources = null;
            for (const { owner } of adoptedOwners) owner.invalidate();
        },
        readHealthAlertSource,
        refreshActivatedPlugin,
        resolveAdoptedDefinitionSet,
        resolveHistoryGapSource,
    });
}
