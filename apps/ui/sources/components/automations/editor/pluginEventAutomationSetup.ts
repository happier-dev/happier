import {
    type AutomationEventFilterV1,
    type DaemonContributionRegistryProjectionAutomationEligibleEventV1,
} from '@happier-dev/protocol';
import { reconstructPluginUiSelectedActionInput } from '@happier-dev/protocol/plugins/ui';
import type { MutableRefObject } from 'react';

import type {
    DaemonMergedProjectionInputs,
} from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import {
    createPluginContributedActionController,
    type PluginContributedActionConnectedAccountOptionsTransport,
    type PluginContributedActionCurrentSnapshot,
    type PluginContributedActionDispatch,
} from '@/components/plugins/actions/pluginContributedActionController';
import { presentActionInputForm } from '@/components/plugins/actions/presentActionInputForm';
import { dispatchPluginSurfaceAction } from '@/components/plugins/surfaces/pluginSurfaceActionDispatch';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import type { FreshPluginMachineExecutionOriginV1 } from '@/sync/domains/machines/administration/usePluginExecutionOriginSelection';
import {
    createPluginUiProjectedActionResolver,
    normalizePluginUiProjection,
} from '@/sync/domains/plugins/ui/projection';
import {
    areFreshPluginMachineExecutionOriginsCurrent,
    arePluginContributionIdentitiesEqual,
} from '@/sync/domains/automations/pluginEventAutomationCurrentness';

import {
    createPluginEventAutomationAuthoringDraft,
    type PluginEventAutomationCreateDraft,
    type PluginEventAutomationObservationDraft,
} from './pluginEventAutomationDraft';
import {
    ensurePluginEventAutomationWebhookEndpoint,
    type PluginEventAutomationWebhookEndpoint,
} from './pluginEventAutomationWebhookEndpoint';
import { validatePluginEventAutomationSetupResult } from './pluginEventAutomationSetupResult';

type SetupOutcome =
    | Readonly<{
        kind: 'configured';
        draft: PluginEventAutomationCreateDraft;
        /**
         * Present only for the durable-push arm. The server discloses the
         * shared secret exactly once, so the composer must surface it with the
         * public URL in the same pass that ensured the endpoint.
         */
        webhookEndpoint: PluginEventAutomationWebhookEndpoint | null;
    }>
    | Readonly<{ kind: 'unavailable' }>
    | Readonly<{ kind: 'stale'; reason: 'event_retired' }>;

export type PluginEventAutomationWebhookEndpointEnsurer =
    typeof ensurePluginEventAutomationWebhookEndpoint;

function sameEligibleEvent(
    left: DaemonContributionRegistryProjectionAutomationEligibleEventV1,
    right: DaemonContributionRegistryProjectionAutomationEligibleEventV1,
): boolean {
    return arePluginContributionIdentitiesEqual(left.event.identity, right.event.identity)
        && left.event.immutableGenerationId === right.event.immutableGenerationId
        && arePluginContributionIdentitiesEqual(left.setupAction.identity, right.setupAction.identity)
        && left.setupAction.immutableGenerationId === right.setupAction.immutableGenerationId;
}

type CurrentSetupSnapshot = Readonly<{
    inputs: DaemonMergedProjectionInputs;
    event: DaemonContributionRegistryProjectionAutomationEligibleEventV1;
    origin: FreshPluginMachineExecutionOriginV1;
    expectedGeneration: string;
    actionSnapshot: PluginContributedActionCurrentSnapshot;
}>;

function resolveCurrentSetupSnapshot(params: Readonly<{
    desiredEvent: DaemonContributionRegistryProjectionAutomationEligibleEventV1;
    inputs: DaemonMergedProjectionInputs | null;
    origin: FreshPluginMachineExecutionOriginV1 | null;
    accountLifetime: ActiveServerAccountScopeLifetime;
    signal: AbortSignal;
    resolveExecutionOrigin: () => FreshPluginMachineExecutionOriginV1 | null;
    actionSnapshotRef: MutableRefObject<PluginContributedActionCurrentSnapshot | null>;
}>): CurrentSetupSnapshot | SetupOutcome {
    const inputs = params.inputs;
    const origin = params.origin;
    if (!inputs || !origin || params.signal.aborted || !params.accountLifetime.isCurrent()) {
        return { kind: 'unavailable' };
    }
    const event = inputs.automationEligibleEvents?.find((candidate) => (
        arePluginContributionIdentitiesEqual(candidate.event.identity, params.desiredEvent.event.identity)
    )) ?? null;
    if (!event || !sameEligibleEvent(event, params.desiredEvent)) {
        return { kind: 'stale', reason: 'event_retired' };
    }
    const plugin = inputs.pluginProjectionById[event.setupAction.identity.pluginId] ?? null;
    if (
        !plugin
        || plugin.pluginId !== event.setupAction.identity.pluginId
        || plugin.enabled !== true
        || plugin.generation === null
        || plugin.immutableGenerationId !== event.setupAction.immutableGenerationId
    ) {
        return { kind: 'stale', reason: 'event_retired' };
    }
    const resolveContributedAction = createPluginUiProjectedActionResolver(
        inputs.pluginProjectionV2?.actionsById,
    );
    let actionSnapshot!: PluginContributedActionCurrentSnapshot;
    actionSnapshot = {
        pluginProjectionById: inputs.pluginProjectionById,
        pluginUiProjection: normalizePluginUiProjection(inputs.pluginProjectionV2 ?? null),
        resolveContributedAction,
        host: {
            machineId: origin.machineTarget.target.machineId,
            serverId: origin.machineTarget.serverId,
            expectedGeneration: String(plugin.generation),
            signal: params.signal,
            accountLifetime: params.accountLifetime,
            isCurrent: () => {
                let currentOrigin: FreshPluginMachineExecutionOriginV1 | null = null;
                try {
                    currentOrigin = params.resolveExecutionOrigin();
                } catch {
                    return false;
                }
                return params.actionSnapshotRef.current === actionSnapshot
                    && !params.signal.aborted
                    && params.accountLifetime.isCurrent()
                    && currentOrigin !== null
                    && areFreshPluginMachineExecutionOriginsCurrent(currentOrigin, origin);
            },
        },
    };
    return {
        inputs,
        event,
        origin,
        expectedGeneration: String(plugin.generation),
        actionSnapshot,
    };
}

/**
 * One exact, no-invoke Event setup transaction. The cold Event projection
 * provides the only setup Action reference; the generic controller owns input
 * collection, and the canonical surface dispatcher owns invocation.
 */
export async function configurePluginEventAutomationSetup(params: Readonly<{
    eligibleEvent: DaemonContributionRegistryProjectionAutomationEligibleEventV1;
    /**
     * The transport the author chose. Durable push additionally ensures the
     * Account webhook endpoint, because the routing source instance it is keyed
     * on only exists once the Event setup Action has returned its source.
     */
    observationTransport: PluginEventAutomationObservationDraft['kind'];
    filter: AutomationEventFilterV1 | null;
    maximumObservationAgeMs: number | null;
    accountLifetime: ActiveServerAccountScopeLifetime;
    ensureWebhookEndpoint?: PluginEventAutomationWebhookEndpointEnsurer;
    signal?: AbortSignal;
    resolveExecutionOrigin: () => FreshPluginMachineExecutionOriginV1 | null;
    loadCurrentProjection: (params: Readonly<{
        machineId: string;
        serverId: string | null;
    }>) => Promise<DaemonMergedProjectionInputs | null>;
    resolveConnectedAccountOptions?: PluginContributedActionConnectedAccountOptionsTransport;
    present?: typeof presentActionInputForm;
    dispatch?: PluginContributedActionDispatch;
}>): Promise<SetupOutcome> {
    const operationScope = new AbortController();
    const retirement = params.accountLifetime.onRetire(() => operationScope.abort());
    const onExternalAbort = () => operationScope.abort();
    if (params.signal?.aborted) operationScope.abort();
    params.signal?.addEventListener('abort', onExternalAbort, { once: true });
    const actionSnapshotRef: MutableRefObject<PluginContributedActionCurrentSnapshot | null> = {
        current: null,
    };
    const currentOrigin = params.resolveExecutionOrigin();
    if (
        !currentOrigin
        || !params.accountLifetime.isCurrent()
        || currentOrigin.origin.materializationRef.pluginId !== params.eligibleEvent.event.identity.pluginId
        || currentOrigin.materialization.pluginId !== params.eligibleEvent.event.identity.pluginId
    ) {
        params.signal?.removeEventListener('abort', onExternalAbort);
        retirement.dispose();
        return { kind: 'unavailable' };
    }
    const load = async (origin: FreshPluginMachineExecutionOriginV1) => {
        const inputs = await params.loadCurrentProjection({
            machineId: origin.machineTarget.target.machineId,
            serverId: origin.machineTarget.serverId,
        });
        const currentOrigin = params.resolveExecutionOrigin();
        if (!currentOrigin) return { kind: 'unavailable' } as const;
        if (!areFreshPluginMachineExecutionOriginsCurrent(origin, currentOrigin)) {
            return { kind: 'stale', reason: 'event_retired' } as const;
        }
        return resolveCurrentSetupSnapshot({
            desiredEvent: params.eligibleEvent,
            inputs,
            origin: currentOrigin,
            accountLifetime: params.accountLifetime,
            signal: operationScope.signal,
            resolveExecutionOrigin: params.resolveExecutionOrigin,
            actionSnapshotRef,
        });
    };

    try {
        const initial = await load(currentOrigin);
        if ('kind' in initial) return initial;
        actionSnapshotRef.current = initial.actionSnapshot;
        const controller = createPluginContributedActionController({
            resolveCurrent: () => actionSnapshotRef.current,
            ...(params.dispatch ? { dispatch: params.dispatch } : {}),
            ...(params.resolveConnectedAccountOptions
                ? { resolveConnectedAccountOptions: params.resolveConnectedAccountOptions }
                : {}),
        });
        const selection = await controller.selectExactBoundActionInput({
            action: initial.event.setupAction.identity,
            expectedImmutableGenerationId: initial.event.setupAction.immutableGenerationId,
        });
        const settled = selection.kind === 'form'
            ? await (async () => {
                try {
                    (params.present ?? presentActionInputForm)({
                        form: selection.form,
                        signal: operationScope.signal,
                    });
                    return await selection.result;
                } finally {
                    selection.form.retire();
                }
            })()
            : selection.kind === 'direct'
                ? selection.result
                : selection;
        if (settled.kind !== 'submitted') return { kind: 'unavailable' };
        if (operationScope.signal.aborted) return { kind: 'unavailable' };

        const current = await load(initial.origin);
        if ('kind' in current) return current;
        actionSnapshotRef.current = current.actionSnapshot;
        if (
            !sameEligibleEvent(current.event, initial.event)
            || !areFreshPluginMachineExecutionOriginsCurrent(current.origin, initial.origin)
        ) {
            return { kind: 'stale', reason: 'event_retired' };
        }
        const input = reconstructPluginUiSelectedActionInput(settled);
        if (!input || operationScope.signal.aborted) return { kind: 'unavailable' };
        const dispatch = params.dispatch ?? dispatchPluginSurfaceAction;
        const outcome = await dispatch({
            action: current.event.setupAction.identity,
            input,
            resolveContributedAction: current.actionSnapshot.resolveContributedAction,
            contributedAction: {
                machineId: current.origin.machineTarget.target.machineId,
                serverId: current.origin.machineTarget.serverId,
                expectedGeneration: current.expectedGeneration,
                expectedImmutableGenerationId: current.event.setupAction.immutableGenerationId,
            },
            signal: operationScope.signal,
            isCurrent: current.actionSnapshot.host.isCurrent,
        });
        if (!outcome.ok || operationScope.signal.aborted) return { kind: 'unavailable' };
        const source = validatePluginEventAutomationSetupResult({
            eligibleEvent: current.event,
            result: outcome.result,
        });
        if (source.kind !== 'available') return { kind: 'unavailable' };
        const webhookEndpoint = params.observationTransport === 'durablePush'
            ? await (params.ensureWebhookEndpoint ?? ensurePluginEventAutomationWebhookEndpoint)({
                eligibleEvent: current.event,
                origin: current.origin,
                sourceInstanceId: source.result.sourceInstanceId,
                accountLifetime: params.accountLifetime,
                signal: operationScope.signal,
            })
            : null;
        if (webhookEndpoint?.kind === 'unavailable' || operationScope.signal.aborted) {
            return { kind: 'unavailable' };
        }
        const draft = createPluginEventAutomationAuthoringDraft({
            eligibleEvent: current.event,
            setupResult: source.result,
            watcherOrigin: current.origin.origin,
            observation: webhookEndpoint
                ? { kind: 'durablePush', webhookEndpointId: webhookEndpoint.endpoint.webhookEndpointId }
                : { kind: 'checkpointedPull' },
            filter: params.filter,
            maximumObservationAgeMs: params.maximumObservationAgeMs,
        });
        if (!draft) return { kind: 'unavailable' };
        return {
            kind: 'configured',
            draft: Object.freeze({
                draft,
                resolveFreshWatcherOrigin: params.resolveExecutionOrigin,
            }),
            webhookEndpoint: webhookEndpoint?.endpoint ?? null,
        };
    } catch {
        return operationScope.signal.aborted || !params.accountLifetime.isCurrent()
            ? { kind: 'unavailable' }
            : { kind: 'unavailable' };
    } finally {
        actionSnapshotRef.current = null;
        operationScope.abort();
        params.signal?.removeEventListener('abort', onExternalAbort);
        retirement.dispose();
    }
}
