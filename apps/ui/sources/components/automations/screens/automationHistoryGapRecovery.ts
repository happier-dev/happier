import { arePluginMachineMaterializationRefsEqual } from '@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1';
import { pluginSourceCustodyV1Equal } from '@happier-dev/protocol/plugins/runtime/sourceCustody';
import type { AutomationEventSourceStatusV1 } from '@happier-dev/protocol/automations/automationEventSourceStatusV1';
import type { AutomationDefinitionListItem } from '@happier-dev/protocol/automations/automationApiV3';
import type { AutomationTriggerListItem } from '@happier-dev/protocol/automations/automationTriggerProjectionV1';
import type { DaemonContributionRegistryProjectionAutomationEligibleEventV1 } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { reconstructPluginUiSelectedActionInput } from '@happier-dev/protocol/plugins/ui';
import type { MutableRefObject } from 'react';

import type { DaemonMergedProjectionInputs } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import {
    createPluginContributedActionController,
    type PluginContributedActionCurrentSnapshot,
    type PluginContributedActionDispatch,
} from '@/components/plugins/actions/pluginContributedActionController';
import { dispatchPluginSurfaceAction } from '@/components/plugins/surfaces/pluginSurfaceActionDispatch';
import type { PluginSurfaceActionDispatchOutcome } from '@/components/plugins/surfaces/actionFailure';
import {
    readFreshPluginMachineExecutionOriginCandidates,
    resolveFreshPluginMachineExecutionOrigin,
    type FreshPluginMachineExecutionOriginV1,
} from '@/sync/domains/machines/administration/usePluginExecutionOriginSelection';
import { getPluginExecutionOriginCandidateOrigin, isPluginMachineExecutionOriginCandidateSelectable } from '@/sync/domains/machines/administration/pluginExecutionOrigin';
import { resolvePluginEventAutomationObserverMaterialization } from '@/components/automations/editor/pluginEventAutomationObservationBinding';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import {
    createPluginUiProjectedActionResolver,
} from '@/sync/domains/plugins/ui/projection';
import {
    areFreshPluginMachineExecutionOriginsCurrent,
    arePluginContributionIdentitiesEqual,
} from '@/sync/domains/automations/pluginEventAutomationCurrentness';

type HistoryGapRecoveryOutcome =
    | Readonly<{ kind: 'settled' }>
    | Readonly<{ kind: 'unavailable'; failure?: Extract<PluginSurfaceActionDispatchOutcome, { ok: false }> }>
    | Readonly<{ kind: 'stale' }>;

function sameCurrentSourceStatus(
    left: AutomationEventSourceStatusV1,
    right: AutomationEventSourceStatusV1,
): boolean {
    return left.automationId === right.automationId
        && left.triggerId === right.triggerId
        && left.triggerRevision === right.triggerRevision
        && arePluginContributionIdentitiesEqual(left.eventRef, right.eventRef)
        && left.sourceSelectorId === right.sourceSelectorId
        && arePluginMachineMaterializationRefsEqual(
            left.reporterMaterializationRef,
            right.reporterMaterializationRef,
        )
        && pluginSourceCustodyV1Equal(left.reporterSourceCustody, right.reporterSourceCustody)
        && left.state === right.state
        && left.code === right.code
        && left.revision === right.revision;
}

function sameAutomationEventSource(
    left: AutomationDefinitionListItem,
    right: AutomationDefinitionListItem,
    triggerId: string,
): boolean {
    const leftTrigger = readPluginEventTrigger(left, triggerId);
    const rightTrigger = readPluginEventTrigger(right, triggerId);
    if (!leftTrigger || !rightTrigger) return false;
    return left.id === right.id
        && leftTrigger.revision === rightTrigger.revision
        && arePluginContributionIdentitiesEqual(leftTrigger.eventRef, rightTrigger.eventRef)
        && leftTrigger.sourceSelectorId === rightTrigger.sourceSelectorId
        && leftTrigger.observation.kind === rightTrigger.observation.kind;
}

type PluginEventTriggerListItem = Extract<
    AutomationTriggerListItem,
    Readonly<{ kind: 'pluginEvent' }>
>;

function readPluginEventTrigger(
    automation: AutomationDefinitionListItem | null | undefined,
    triggerId: string,
): PluginEventTriggerListItem | null {
    if (!automation) return null;
    const trigger = automation.triggers.find((candidate) => candidate.id === triggerId);
    return trigger?.kind === 'pluginEvent' ? trigger : null;
}

/**
 * The status/store owner may retain historical source rows, but this detail
 * action is meaningful only for the definition's exact current pull source.
 */
export function readAutomationHistoryGapRecoveryStatus(
    automation: AutomationDefinitionListItem | null | undefined,
    triggerId: string,
): AutomationEventSourceStatusV1 | null {
    const trigger = readPluginEventTrigger(automation, triggerId);
    if (!automation || !automation.enabled || !trigger?.enabled) return null;
    if (trigger.observation.kind !== 'checkpointedPull') return null;
    const status = trigger.sourceStatus;
    if (
        !status
        || status.state !== 'attention'
        || status.code !== 'historyGap'
        || status.automationId !== automation.id
        || status.triggerId !== trigger.id
        || status.triggerRevision !== trigger.revision
        || !arePluginContributionIdentitiesEqual(status.eventRef, trigger.eventRef)
        || status.sourceSelectorId !== trigger.sourceSelectorId
        || status.reporterMaterializationRef.pluginId !== trigger.eventRef.pluginId
    ) {
        return null;
    }
    return status;
}

/** Reuse Administration admission for the reporting watcher's exact installed or native source. */
export function resolveAutomationHistoryGapRecoveryExecutionOrigin(params: Readonly<{
    automation: AutomationDefinitionListItem | null;
    triggerId: string;
}> & Pick<Parameters<typeof resolveFreshPluginMachineExecutionOrigin>[0], 'reader' | 'classifyRelease' | 'sourceCandidates' | 'machineRejections'>): FreshPluginMachineExecutionOriginV1 | null {
    const status = readAutomationHistoryGapRecoveryStatus(params.automation, params.triggerId);
    if (!status) return null;
    const inputs = { ...params, pluginId: status.eventRef.pluginId, origin: null };
    const matches = readFreshPluginMachineExecutionOriginCandidates(inputs).filter(candidate => {
        if (!isPluginMachineExecutionOriginCandidateSelectable(candidate)) return false;
        const origin = getPluginExecutionOriginCandidateOrigin(candidate);
        return 'materializationRef' in origin
            ? arePluginMachineMaterializationRefsEqual(origin.materializationRef, status.reporterMaterializationRef)
            : origin.sourceRef.machineId === status.reporterMaterializationRef.machineId
                && origin.sourceRef.pluginId === status.reporterMaterializationRef.pluginId
                && pluginSourceCustodyV1Equal(origin.sourceRef.sourceCustody, status.reporterSourceCustody);
    });
    if (matches.length !== 1) return null;
    return resolveFreshPluginMachineExecutionOrigin({ ...inputs, origin: getPluginExecutionOriginCandidateOrigin(matches[0]!) });
}

/** The cold catalog is the one Action binding source; this only reads its exact Event entry. */
export function readAutomationHistoryGapRecoveryEligibleEvent(params: Readonly<{
    inputs: DaemonMergedProjectionInputs | null | undefined;
    automation: AutomationDefinitionListItem | null | undefined;
    triggerId: string;
}>): DaemonContributionRegistryProjectionAutomationEligibleEventV1 | null {
    const status = readAutomationHistoryGapRecoveryStatus(params.automation, params.triggerId);
    const automation = params.automation;
    const trigger = readPluginEventTrigger(automation, params.triggerId);
    if (!status || !automation || !trigger) return null;
    const matches = (params.inputs?.automationEligibleEvents ?? []).filter((candidate) => {
        const action = candidate.historyGapResetAction;
        const declaredAction = candidate.event.automation.source.historyGapResetActionRef;
        return action !== undefined
            && declaredAction !== undefined
            && candidate.event.automation.source.supportedObservationTransports.includes('checkpointedPull')
            && pluginSourceCustodyV1Equal(
                status.reporterSourceCustody,
                candidate.event.sourceCustody,
            )
            && arePluginContributionIdentitiesEqual(candidate.event.identity, trigger.eventRef)
            && candidate.event.identity.pluginId === action.identity.pluginId
            && candidate.event.occurrenceId === action.occurrenceId
            && arePluginContributionIdentitiesEqual(action.identity, declaredAction)
            && declaredAction.pluginId === candidate.event.identity.pluginId;
    });
    return matches.length === 1 ? matches[0]! : null;
}

function sameRecoveryEligibleEvent(
    left: DaemonContributionRegistryProjectionAutomationEligibleEventV1,
    right: DaemonContributionRegistryProjectionAutomationEligibleEventV1,
): boolean {
    const leftAction = left.historyGapResetAction;
    const rightAction = right.historyGapResetAction;
    return leftAction !== undefined
        && rightAction !== undefined
        && arePluginContributionIdentitiesEqual(left.event.identity, right.event.identity)
        && left.event.occurrenceId === right.event.occurrenceId
        && arePluginContributionIdentitiesEqual(leftAction.identity, rightAction.identity)
        && leftAction.occurrenceId === rightAction.occurrenceId;
}

type CurrentRecoverySnapshot = Readonly<{
    automation: AutomationDefinitionListItem;
    status: AutomationEventSourceStatusV1;
    inputs: DaemonMergedProjectionInputs;
    event: DaemonContributionRegistryProjectionAutomationEligibleEventV1;
    origin: FreshPluginMachineExecutionOriginV1;
    actionSnapshot: PluginContributedActionCurrentSnapshot;
}>;

function resolveCurrentRecoverySnapshot(params: Readonly<{
    desiredEvent: DaemonContributionRegistryProjectionAutomationEligibleEventV1;
    triggerId: string;
    inputs: DaemonMergedProjectionInputs | null;
    accountLifetime: ActiveServerAccountScopeLifetime;
    signal: AbortSignal;
    resolveCurrentAutomation: () => AutomationDefinitionListItem | null;
    resolveExecutionOrigin: () => FreshPluginMachineExecutionOriginV1 | null;
    actionSnapshotRef: MutableRefObject<PluginContributedActionCurrentSnapshot | null>;
}>): CurrentRecoverySnapshot | HistoryGapRecoveryOutcome {
    const automation = params.resolveCurrentAutomation();
    const status = readAutomationHistoryGapRecoveryStatus(automation, params.triggerId);
    const origin = params.resolveExecutionOrigin();
    if (!automation || !status || !origin || params.signal.aborted || !params.accountLifetime.isCurrent()) {
        return { kind: 'unavailable' };
    }
    const event = readAutomationHistoryGapRecoveryEligibleEvent({
        inputs: params.inputs,
        automation,
        triggerId: params.triggerId,
    });
    if (!event || !sameRecoveryEligibleEvent(event, params.desiredEvent)) {
        return { kind: 'stale' };
    }
    const reporter = resolvePluginEventAutomationObserverMaterialization(event, origin.origin);
    if (!reporter || !arePluginMachineMaterializationRefsEqual(reporter, status.reporterMaterializationRef)) {
        return { kind: 'stale' };
    }
    const action = event.historyGapResetAction;
    if (!action) return { kind: 'stale' };
    const plugin = params.inputs?.pluginProjectionById[action.identity.pluginId] ?? null;
    if (
        !plugin
        || plugin.pluginId !== action.identity.pluginId
        || plugin.enabled !== true
    ) {
        return { kind: 'stale' };
    }
    const resolveContributedAction = createPluginUiProjectedActionResolver(
        params.inputs?.pluginProjectionV2?.actionsById,
    );
    let actionSnapshot!: PluginContributedActionCurrentSnapshot;
    actionSnapshot = {
        pluginProjectionById: params.inputs!.pluginProjectionById,
        pluginUiProjection: params.inputs!.pluginUiProjection,
        resolveContributedAction,
        host: {
            machineId: origin.machineTarget.target.machineId,
            serverId: origin.machineTarget.serverId,
            signal: params.signal,
            accountLifetime: params.accountLifetime,
            isCurrent: () => {
                const currentAutomation = params.resolveCurrentAutomation();
                const currentStatus = readAutomationHistoryGapRecoveryStatus(currentAutomation, params.triggerId);
                let currentOrigin: FreshPluginMachineExecutionOriginV1 | null = null;
                try {
                    currentOrigin = params.resolveExecutionOrigin();
                } catch {
                    return false;
                }
                const currentReporter = currentOrigin && resolvePluginEventAutomationObserverMaterialization(event, currentOrigin.origin);
                return params.actionSnapshotRef.current === actionSnapshot
                    && !params.signal.aborted
                    && params.accountLifetime.isCurrent()
                    && currentAutomation !== null
                    && sameAutomationEventSource(currentAutomation, automation, params.triggerId)
                    && currentStatus !== null
                    && sameCurrentSourceStatus(currentStatus, status)
                    && currentOrigin !== null
                    && areFreshPluginMachineExecutionOriginsCurrent(currentOrigin, origin)
                    && currentReporter !== null
                    && arePluginMachineMaterializationRefsEqual(
                        currentReporter,
                        currentStatus.reporterMaterializationRef,
                    );
            },
        },
    };
    return {
        automation,
        status,
        inputs: params.inputs!,
        event,
        origin,
        actionSnapshot,
    };
}

/**
 * Invokes only the current Event-declared recovery Action. Its result is
 * deliberately not interpreted locally: the detail surface re-reads the
 * canonical Automation status after every terminal Action settlement.
 */
export async function recoverAutomationHistoryGap(params: Readonly<{
    eligibleEvent: DaemonContributionRegistryProjectionAutomationEligibleEventV1;
    triggerId: string;
    accountLifetime: ActiveServerAccountScopeLifetime;
    signal?: AbortSignal;
    resolveCurrentAutomation: () => AutomationDefinitionListItem | null;
    resolveExecutionOrigin: () => FreshPluginMachineExecutionOriginV1 | null;
    loadCurrentProjection: (params: Readonly<{
        machineId: string;
        serverId: string | null;
    }>) => Promise<DaemonMergedProjectionInputs | null>;
    dispatch?: PluginContributedActionDispatch;
}>): Promise<HistoryGapRecoveryOutcome> {
    const operationScope = new AbortController();
    const retirement = params.accountLifetime.onRetire(() => operationScope.abort());
    const onExternalAbort = () => operationScope.abort();
    if (params.signal?.aborted) operationScope.abort();
    params.signal?.addEventListener('abort', onExternalAbort, { once: true });
    const actionSnapshotRef: MutableRefObject<PluginContributedActionCurrentSnapshot | null> = { current: null };

    const load = async (origin: FreshPluginMachineExecutionOriginV1) => {
        const inputs = await params.loadCurrentProjection({
            machineId: origin.machineTarget.target.machineId,
            serverId: origin.machineTarget.serverId,
        });
        const currentOrigin = params.resolveExecutionOrigin();
        if (!currentOrigin || !areFreshPluginMachineExecutionOriginsCurrent(origin, currentOrigin)) {
            return { kind: 'stale' } as const;
        }
        return resolveCurrentRecoverySnapshot({
            desiredEvent: params.eligibleEvent,
            triggerId: params.triggerId,
            inputs,
            accountLifetime: params.accountLifetime,
            signal: operationScope.signal,
            resolveCurrentAutomation: params.resolveCurrentAutomation,
            resolveExecutionOrigin: params.resolveExecutionOrigin,
            actionSnapshotRef,
        });
    };

    try {
        const initialOrigin = params.resolveExecutionOrigin();
        if (!initialOrigin || !params.accountLifetime.isCurrent() || operationScope.signal.aborted) {
            return { kind: 'unavailable' };
        }
        const initial = await load(initialOrigin);
        if ('kind' in initial) return initial;
        actionSnapshotRef.current = initial.actionSnapshot;
        const action = initial.event.historyGapResetAction;
        if (!action) return { kind: 'stale' };
        // Re-read immediately before entering the generic Action selector. Its
        // declared durable confirmation owns present-user consent; this flow
        // only retains source/catalog currentness.
        const currentBeforeSelection = await load(initial.origin);
        if ('kind' in currentBeforeSelection) return currentBeforeSelection;
        if (
            !sameRecoveryEligibleEvent(currentBeforeSelection.event, initial.event)
            || !areFreshPluginMachineExecutionOriginsCurrent(currentBeforeSelection.origin, initial.origin)
            || !sameAutomationEventSource(
                currentBeforeSelection.automation,
                initial.automation,
                params.triggerId,
            )
            || !sameCurrentSourceStatus(currentBeforeSelection.status, initial.status)
        ) {
            return { kind: 'stale' };
        }
        actionSnapshotRef.current = currentBeforeSelection.actionSnapshot;
        const initialTrigger = readPluginEventTrigger(initial.automation, params.triggerId);
        if (!initialTrigger) return { kind: 'stale' };
        const selection = await createPluginContributedActionController({
            resolveCurrent: () => actionSnapshotRef.current,
        }).selectExactBoundActionInput({
            action: action.identity,
            expectedOccurrenceId: action.occurrenceId,
            draft: {
                automationId: initial.automation.id,
                triggerId: initialTrigger.id,
                triggerRevision: initialTrigger.revision,
                sourceSelectorId: initialTrigger.sourceSelectorId,
            },
        });
        const selected = selection.kind === 'form'
            ? await (async () => {
                try {
                    // Recovery's complete source identity is host-filled. Reuse the
                    // canonical form validation without presenting those identity fields.
                    const submitted = await selection.form.submit();
                    if (submitted.kind !== 'settled' || !submitted.outcome.ok) {
                        selection.form.cancel();
                        return null;
                    }
                    return await selection.result;
                } finally {
                    selection.form.retire();
                }
            })()
            : selection.kind === 'direct' ? selection.result : null;
        if (selected?.kind !== 'submitted' || operationScope.signal.aborted) {
            return { kind: 'unavailable' };
        }

        const current = await load(initial.origin);
        if ('kind' in current) return current;
        if (
            !sameRecoveryEligibleEvent(current.event, initial.event)
            || !areFreshPluginMachineExecutionOriginsCurrent(current.origin, initial.origin)
            || !sameAutomationEventSource(current.automation, initial.automation, params.triggerId)
            || !sameCurrentSourceStatus(current.status, initial.status)
        ) {
            return { kind: 'stale' };
        }
        actionSnapshotRef.current = current.actionSnapshot;
        const input = reconstructPluginUiSelectedActionInput(selected);
        if (!input || operationScope.signal.aborted) return { kind: 'unavailable' };
        const outcome = await (params.dispatch ?? dispatchPluginSurfaceAction)({
            action: action.identity,
            input,
            resolveContributedAction: current.actionSnapshot.resolveContributedAction,
            contributedAction: {
                machineId: current.origin.machineTarget.target.machineId,
                serverId: current.origin.machineTarget.serverId,
            },
            signal: operationScope.signal,
            isCurrent: current.actionSnapshot.host.isCurrent,
        });
        if (!outcome.ok) return { kind: 'unavailable', failure: outcome };
        return operationScope.signal.aborted ? { kind: 'unavailable' } : { kind: 'settled' };
    } catch {
        return { kind: 'unavailable' };
    } finally {
        actionSnapshotRef.current = null;
        operationScope.abort();
        params.signal?.removeEventListener('abort', onExternalAbort);
        retirement.dispose();
    }
}
