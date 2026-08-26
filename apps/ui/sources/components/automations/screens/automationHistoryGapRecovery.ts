import {
    type AutomationEventSourceStatusV1,
    type AutomationDefinitionListItem,
    type DaemonContributionRegistryProjectionAutomationEligibleEventV1,
} from '@happier-dev/protocol';
import { reconstructPluginUiSelectedActionInput } from '@happier-dev/protocol/plugins/ui';
import type { MutableRefObject } from 'react';

import type { DaemonMergedProjectionInputs } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import {
    createPluginContributedActionController,
    type PluginContributedActionCurrentSnapshot,
    type PluginContributedActionDispatch,
} from '@/components/plugins/actions/pluginContributedActionController';
import { dispatchPluginSurfaceAction } from '@/components/plugins/surfaces/pluginSurfaceActionDispatch';
import type { FreshPluginMachineExecutionOriginV1 } from '@/sync/domains/machines/administration/usePluginExecutionOriginSelection';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { isPluginEventAutomationDefinition } from '@/sync/domains/automations/automationTypes';
import {
    createPluginUiProjectedActionResolver,
    normalizePluginUiProjection,
} from '@/sync/domains/plugins/ui/projection';
import {
    areFreshPluginMachineExecutionOriginsCurrent,
    arePluginContributionIdentitiesEqual,
    arePluginMachineMaterializationRefsEqual,
} from '@/sync/domains/automations/pluginEventAutomationCurrentness';

type HistoryGapRecoveryOutcome =
    | Readonly<{ kind: 'settled' }>
    | Readonly<{ kind: 'unavailable' }>
    | Readonly<{ kind: 'stale' }>;

function sameCurrentSourceStatus(
    left: AutomationEventSourceStatusV1,
    right: AutomationEventSourceStatusV1,
): boolean {
    return left.automationId === right.automationId
        && left.templateVersion === right.templateVersion
        && arePluginContributionIdentitiesEqual(left.eventRef, right.eventRef)
        && left.sourceSelectorId === right.sourceSelectorId
        && arePluginMachineMaterializationRefsEqual(
            left.reporterMaterializationRef,
            right.reporterMaterializationRef,
        )
        && left.reporterImmutableGenerationId === right.reporterImmutableGenerationId
        && left.state === right.state
        && left.code === right.code
        && left.revision === right.revision;
}

function sameAutomationEventSource(
    left: AutomationDefinitionListItem,
    right: AutomationDefinitionListItem,
): boolean {
    if (!isPluginEventAutomationDefinition(left) || !isPluginEventAutomationDefinition(right)) return false;
    return left.id === right.id
        && left.templateVersion === right.templateVersion
        && arePluginContributionIdentitiesEqual(left.trigger.eventRef, right.trigger.eventRef)
        && left.trigger.sourceSelectorId === right.trigger.sourceSelectorId
        && left.trigger.observation.kind === right.trigger.observation.kind;
}

/**
 * The status/store owner may retain historical source rows, but this detail
 * action is meaningful only for the definition's exact current pull source.
 */
export function readAutomationHistoryGapRecoveryStatus(
    automation: AutomationDefinitionListItem | null | undefined,
): AutomationEventSourceStatusV1 | null {
    if (!automation || !automation.enabled || !isPluginEventAutomationDefinition(automation)) return null;
    if (automation.trigger.observation.kind !== 'checkpointedPull') return null;
    const status = automation.sourceStatus;
    if (
        !status
        || status.state !== 'attention'
        || status.code !== 'historyGap'
        || status.automationId !== automation.id
        || status.templateVersion !== automation.templateVersion
        || !arePluginContributionIdentitiesEqual(status.eventRef, automation.trigger.eventRef)
        || status.sourceSelectorId !== automation.trigger.sourceSelectorId
        || status.reporterMaterializationRef.pluginId !== automation.trigger.eventRef.pluginId
    ) {
        return null;
    }
    return status;
}

/** The cold catalog is the one Action binding source; this only reads its exact Event entry. */
export function readAutomationHistoryGapRecoveryEligibleEvent(params: Readonly<{
    inputs: DaemonMergedProjectionInputs | null | undefined;
    automation: AutomationDefinitionListItem | null | undefined;
}>): DaemonContributionRegistryProjectionAutomationEligibleEventV1 | null {
    const status = readAutomationHistoryGapRecoveryStatus(params.automation);
    const automation = params.automation;
    if (!status || !automation || !isPluginEventAutomationDefinition(automation)) return null;
    const matches = (params.inputs?.automationEligibleEvents ?? []).filter((candidate) => {
        const action = candidate.historyGapResetAction;
        const declaredAction = candidate.event.automation.source.historyGapResetActionRef;
        return action !== undefined
            && declaredAction !== undefined
            && candidate.event.automation.source.supportedObservationTransports.includes('checkpointedPull')
            && status.reporterImmutableGenerationId !== undefined
            && status.reporterImmutableGenerationId === candidate.event.immutableGenerationId
            && arePluginContributionIdentitiesEqual(candidate.event.identity, automation.trigger.eventRef)
            && candidate.event.identity.pluginId === action.identity.pluginId
            && candidate.event.immutableGenerationId === action.immutableGenerationId
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
        && left.event.immutableGenerationId === right.event.immutableGenerationId
        && arePluginContributionIdentitiesEqual(leftAction.identity, rightAction.identity)
        && leftAction.immutableGenerationId === rightAction.immutableGenerationId;
}

type CurrentRecoverySnapshot = Readonly<{
    automation: AutomationDefinitionListItem;
    status: AutomationEventSourceStatusV1;
    inputs: DaemonMergedProjectionInputs;
    event: DaemonContributionRegistryProjectionAutomationEligibleEventV1;
    origin: FreshPluginMachineExecutionOriginV1;
    expectedGeneration: string;
    actionSnapshot: PluginContributedActionCurrentSnapshot;
}>;

function resolveCurrentRecoverySnapshot(params: Readonly<{
    desiredEvent: DaemonContributionRegistryProjectionAutomationEligibleEventV1;
    inputs: DaemonMergedProjectionInputs | null;
    accountLifetime: ActiveServerAccountScopeLifetime;
    signal: AbortSignal;
    resolveCurrentAutomation: () => AutomationDefinitionListItem | null;
    resolveExecutionOrigin: () => FreshPluginMachineExecutionOriginV1 | null;
    actionSnapshotRef: MutableRefObject<PluginContributedActionCurrentSnapshot | null>;
}>): CurrentRecoverySnapshot | HistoryGapRecoveryOutcome {
    const automation = params.resolveCurrentAutomation();
    const status = readAutomationHistoryGapRecoveryStatus(automation);
    const origin = params.resolveExecutionOrigin();
    if (!automation || !status || !origin || params.signal.aborted || !params.accountLifetime.isCurrent()) {
        return { kind: 'unavailable' };
    }
    if (!arePluginMachineMaterializationRefsEqual(origin.origin.materializationRef, status.reporterMaterializationRef)) {
        return { kind: 'stale' };
    }
    const event = readAutomationHistoryGapRecoveryEligibleEvent({ inputs: params.inputs, automation });
    if (!event || !sameRecoveryEligibleEvent(event, params.desiredEvent)) {
        return { kind: 'stale' };
    }
    const action = event.historyGapResetAction;
    if (!action) return { kind: 'stale' };
    const plugin = params.inputs?.pluginProjectionById[action.identity.pluginId] ?? null;
    if (
        !plugin
        || plugin.pluginId !== action.identity.pluginId
        || plugin.enabled !== true
        || plugin.generation === null
        || plugin.immutableGenerationId !== action.immutableGenerationId
    ) {
        return { kind: 'stale' };
    }
    const resolveContributedAction = createPluginUiProjectedActionResolver(
        params.inputs?.pluginProjectionV2?.actionsById,
    );
    let actionSnapshot!: PluginContributedActionCurrentSnapshot;
    actionSnapshot = {
        pluginProjectionById: params.inputs!.pluginProjectionById,
        pluginUiProjection: normalizePluginUiProjection(params.inputs!.pluginProjectionV2 ?? null),
        resolveContributedAction,
        host: {
            machineId: origin.machineTarget.target.machineId,
            serverId: origin.machineTarget.serverId,
            expectedGeneration: String(plugin.generation),
            signal: params.signal,
            accountLifetime: params.accountLifetime,
            isCurrent: () => {
                const currentAutomation = params.resolveCurrentAutomation();
                const currentStatus = readAutomationHistoryGapRecoveryStatus(currentAutomation);
                let currentOrigin: FreshPluginMachineExecutionOriginV1 | null = null;
                try {
                    currentOrigin = params.resolveExecutionOrigin();
                } catch {
                    return false;
                }
                return params.actionSnapshotRef.current === actionSnapshot
                    && !params.signal.aborted
                    && params.accountLifetime.isCurrent()
                    && currentAutomation !== null
                    && sameAutomationEventSource(currentAutomation, automation)
                    && currentStatus !== null
                    && sameCurrentSourceStatus(currentStatus, status)
                    && currentOrigin !== null
                    && areFreshPluginMachineExecutionOriginsCurrent(currentOrigin, origin)
                    && arePluginMachineMaterializationRefsEqual(
                        currentOrigin.origin.materializationRef,
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
        expectedGeneration: String(plugin.generation),
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
            || !sameAutomationEventSource(currentBeforeSelection.automation, initial.automation)
            || !sameCurrentSourceStatus(currentBeforeSelection.status, initial.status)
        ) {
            return { kind: 'stale' };
        }
        actionSnapshotRef.current = currentBeforeSelection.actionSnapshot;
        const selection = await createPluginContributedActionController({
            resolveCurrent: () => actionSnapshotRef.current,
        }).selectExactBoundActionInput({
            action: action.identity,
            expectedImmutableGenerationId: action.immutableGenerationId,
            draft: {
                automationId: initial.automation.id,
                templateVersion: initial.automation.templateVersion,
                sourceSelectorId: initial.automation.trigger.kind === 'pluginEvent'
                    ? initial.automation.trigger.sourceSelectorId
                    : '',
            },
        });
        if (selection.kind !== 'direct' || selection.result.kind !== 'submitted' || operationScope.signal.aborted) {
            return { kind: 'unavailable' };
        }

        const current = await load(initial.origin);
        if ('kind' in current) return current;
        if (
            !sameRecoveryEligibleEvent(current.event, initial.event)
            || !areFreshPluginMachineExecutionOriginsCurrent(current.origin, initial.origin)
            || !sameAutomationEventSource(current.automation, initial.automation)
            || !sameCurrentSourceStatus(current.status, initial.status)
        ) {
            return { kind: 'stale' };
        }
        actionSnapshotRef.current = current.actionSnapshot;
        const input = reconstructPluginUiSelectedActionInput(selection.result);
        if (!input || operationScope.signal.aborted) return { kind: 'unavailable' };
        const outcome = await (params.dispatch ?? dispatchPluginSurfaceAction)({
            action: action.identity,
            input,
            resolveContributedAction: current.actionSnapshot.resolveContributedAction,
            contributedAction: {
                machineId: current.origin.machineTarget.target.machineId,
                serverId: current.origin.machineTarget.serverId,
                expectedGeneration: current.expectedGeneration,
                expectedImmutableGenerationId: action.immutableGenerationId,
            },
            signal: operationScope.signal,
            isCurrent: current.actionSnapshot.host.isCurrent,
        });
        return outcome.ok && !operationScope.signal.aborted
            ? { kind: 'settled' }
            : { kind: 'unavailable' };
    } catch {
        return { kind: 'unavailable' };
    } finally {
        actionSnapshotRef.current = null;
        operationScope.abort();
        params.signal?.removeEventListener('abort', onExternalAbort);
        retirement.dispose();
    }
}
