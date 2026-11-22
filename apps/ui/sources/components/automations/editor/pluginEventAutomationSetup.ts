import { arePluginMachineExecutionOriginsEqual, arePluginMachineMaterializationRefsEqual, getPluginMachineExecutionOriginRef } from '@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1';
import type { AutomationEventFilterV1 } from '@happier-dev/protocol/automations/automationEventFilterV1';
import type { PluginEventAutomationSetupResultV1 } from '@happier-dev/protocol/automations/event-setup-result';
import type { DaemonContributionRegistryProjectionAutomationEligibleEventV1 } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import type { PluginDiagnosticRemediationV1 } from '@happier-dev/protocol/daemon/pluginContributionIntrospection';
import { PluginUiJsonValueV1Schema, reconstructPluginUiSelectedActionInput, type PluginUiJsonValueV1 } from '@happier-dev/protocol/plugins/ui';
import { readInputPath, writeInputPath } from '@happier-dev/protocol/inputs';
import { formatQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import type { ActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { MutableRefObject } from 'react';
import type { PluginUiOpenAutomationEventRequestV1 } from '@happier-dev/protocol/plugins/ui';

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
import { randomUUID } from '@/platform/randomUUID';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import type { FreshPluginMachineExecutionOriginV1 } from '@/sync/domains/machines/administration/usePluginExecutionOriginSelection';
import {
    createPluginUiProjectedActionResolver,
} from '@/sync/domains/plugins/ui/projection';
import {
    areFreshPluginMachineExecutionOriginsCurrent,
    arePluginContributionIdentitiesEqual,
} from '@/sync/domains/automations/pluginEventAutomationCurrentness';

import {
    createPluginEventAutomationAuthoringDraft,
    supportsPluginEventAutomationObservationTransport,
    type PluginEventAutomationCreateDraft,
    type PluginEventAutomationObservationDraft,
} from './pluginEventAutomationDraft';
import {
    ensurePluginEventAutomationWebhookEndpoint,
    type PluginEventAutomationWebhookEndpoint,
} from './pluginEventAutomationWebhookEndpoint';
import { validatePluginEventAutomationSetupResult } from './pluginEventAutomationSetupResult';
import { EVENT_OBSERVER_BINDING_UNAVAILABLE, resolvePluginEventAutomationObserverMaterialization } from './pluginEventAutomationObservationBinding';
import { presentPluginEventAutomationSetupSurface, type NativeSetupWatcherChoice, type SetupSurfaceHeading } from './presentPluginEventAutomationSetupSurface';

export type PluginEventAutomationSetupFailure = Readonly<{
    code: string;
    reason: string;
    requestId?: string;
    message?: string;
    details?: PluginUiJsonValueV1;
    failureCause?: ActionFailureCauseV1;
    effectAttempted?: boolean;
    retryable?: boolean;
    remediation?: PluginDiagnosticRemediationV1;
}>;

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
        /** Automatic delivery can enroll polling while exposing endpoint recovery. */
        webhookEndpointUnavailable?: true;
    }>
    | (Readonly<{ kind: 'unavailable' }> & Partial<PluginEventAutomationSetupFailure>)
    | Readonly<{ kind: 'stale'; reason: 'event_retired' }>
    | Readonly<{ kind: 'cancelled' }>
    | Readonly<{ kind: 'superseded'; machineId: string; input: Readonly<Record<string, unknown>> }>;

export type PluginEventAutomationWebhookEndpointEnsurer =
    typeof ensurePluginEventAutomationWebhookEndpoint;

function isSetupSurfaceObjectInput(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function arePluginEventAutomationEligibleSetupPresentationsEqual(
    left: DaemonContributionRegistryProjectionAutomationEligibleEventV1,
    right: DaemonContributionRegistryProjectionAutomationEligibleEventV1,
): boolean {
    return arePluginContributionIdentitiesEqual(left.event.identity, right.event.identity)
        && left.event.occurrenceId === right.event.occurrenceId
        && arePluginContributionIdentitiesEqual(left.setupAction.identity, right.setupAction.identity)
        && left.setupAction.occurrenceId === right.setupAction.occurrenceId
        && sameObservationBinding(left.observationBinding, right.observationBinding)
        && sameSetupSurface(left.setupSurface, right.setupSurface);
}

function sameObservationBinding(
    left: DaemonContributionRegistryProjectionAutomationEligibleEventV1['observationBinding'],
    right: DaemonContributionRegistryProjectionAutomationEligibleEventV1['observationBinding'],
): boolean {
    return left === undefined || right === undefined ? left === right
        : arePluginMachineExecutionOriginsEqual(left.executionOrigin, right.executionOrigin)
            && arePluginMachineMaterializationRefsEqual(left.materializationRef, right.materializationRef);
}

function sameSetupSurface(
    left: DaemonContributionRegistryProjectionAutomationEligibleEventV1['setupSurface'],
    right: DaemonContributionRegistryProjectionAutomationEligibleEventV1['setupSurface'],
): boolean {
    if (left === undefined || right === undefined) return left === right;
    return arePluginContributionIdentitiesEqual(left.contribution, right.contribution)
        && left.occurrenceId === right.occurrenceId
        && left.projectionGeneration === right.projectionGeneration
        && arePluginContributionIdentitiesEqual(
            left.selectedRenderer.identity,
            right.selectedRenderer.identity,
        )
        && arePluginMachineExecutionOriginsEqual(left.executionOrigin, right.executionOrigin);
}

export function getPluginEventAutomationEligibleSetupPresentationKey(
    event: DaemonContributionRegistryProjectionAutomationEligibleEventV1,
): string {
    const surface = event.setupSurface;
    return JSON.stringify([
        event.event.identity.pluginId,
        event.event.identity.localId,
        event.event.occurrenceId,
        event.setupAction.identity.pluginId,
        event.setupAction.identity.localId,
        event.setupAction.occurrenceId,
        event.observationBinding ?? null,
        surface ? [
            surface.contribution.pluginId,
            surface.contribution.localId,
            surface.occurrenceId,
            surface.projectionGeneration,
            surface.selectedRenderer.identity.pluginId,
            surface.selectedRenderer.identity.localId,
            surface.executionOrigin,
        ] : null,
    ]);
}

function hasExactCurrentSetupPresentation(
    event: DaemonContributionRegistryProjectionAutomationEligibleEventV1,
    origin: FreshPluginMachineExecutionOriginV1,
): boolean {
    if (
        event.event.identity.pluginId !== event.setupAction.identity.pluginId
        || event.event.occurrenceId !== event.setupAction.occurrenceId
        || !resolvePluginEventAutomationObserverMaterialization(event, origin.origin)
        || (origin.source !== undefined && origin.source.occurrenceId !== event.event.occurrenceId)
    ) return false;
    const surface = event.setupSurface;
    return surface === undefined || (
        arePluginContributionIdentitiesEqual(surface.contribution, event.event.identity)
        && surface.occurrenceId === event.event.occurrenceId
        && surface.selectedRenderer.identity.pluginId === event.event.identity.pluginId
        && getPluginMachineExecutionOriginRef(surface.executionOrigin).pluginId === event.event.identity.pluginId
        && arePluginMachineExecutionOriginsEqual(surface.executionOrigin, origin.origin)
    );
}

type CurrentSetupSnapshot = Readonly<{
    inputs: DaemonMergedProjectionInputs;
    event: DaemonContributionRegistryProjectionAutomationEligibleEventV1;
    origin: FreshPluginMachineExecutionOriginV1;
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
    if (!event || !arePluginEventAutomationEligibleSetupPresentationsEqual(event, params.desiredEvent)) {
        return { kind: 'stale', reason: 'event_retired' };
    }
    if (!hasExactCurrentSetupPresentation(event, origin)) {
        return { kind: 'stale', reason: 'event_retired' };
    }
    const plugin = inputs.pluginProjectionById[event.setupAction.identity.pluginId] ?? null;
    if (
        !plugin
        || plugin.pluginId !== event.setupAction.identity.pluginId
        || plugin.enabled !== true
    ) {
        return { kind: 'stale', reason: 'event_retired' };
    }
    const resolveContributedAction = createPluginUiProjectedActionResolver(
        inputs.pluginProjectionV2?.actionsById,
    );
    let actionSnapshot!: PluginContributedActionCurrentSnapshot;
    actionSnapshot = {
        pluginProjectionById: inputs.pluginProjectionById,
        pluginUiProjection: inputs.pluginUiProjection,
        resolveContributedAction,
        host: {
            machineId: origin.machineTarget.target.machineId,
            serverId: origin.machineTarget.serverId,
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
        actionSnapshot,
    };
}

/**
 * One exact, no-invoke Event setup transaction. The cold Event projection
 * provides the only setup Action reference; the generic controller owns input
 * collection, and the canonical surface dispatcher owns invocation.
 */
export async function configurePluginEventAutomationSetup(params: Readonly<{
    initialSetupSeed?: PluginUiOpenAutomationEventRequestV1;
    nativeSetupDraft?: Readonly<Record<string, unknown>>;
    watcherChoices?: readonly NativeSetupWatcherChoice[];
    canChooseWatcher?: (machineId: string) => boolean;
    requireNativeRenderer?: boolean;
    /** The host's name for the native setup surface; the Event's own title otherwise. */
    surfaceHeading?: SetupSurfaceHeading;
    /** A saved source edit passes these values only to its native renderer. */
    savedSourceRendererInput?: NonNullable<PluginUiOpenAutomationEventRequestV1['setupInput']>;
    /** The saved source is the initial draft when editing an existing Event. */
    initialSource?: PluginEventAutomationSetupResultV1;
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
    presentSetupSurface?: typeof presentPluginEventAutomationSetupSurface;
    onApplying?: () => void;
    commandBridge?: Parameters<typeof presentPluginEventAutomationSetupSurface>[0]['commandBridge'];
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
        || getPluginMachineExecutionOriginRef(currentOrigin.origin).pluginId !== params.eligibleEvent.event.identity.pluginId
    ) {
        params.signal?.removeEventListener('abort', onExternalAbort);
        retirement.dispose();
        return { kind: 'unavailable' };
    }
    if (!resolvePluginEventAutomationObserverMaterialization(params.eligibleEvent, currentOrigin.origin)) {
        params.signal?.removeEventListener('abort', onExternalAbort);
        retirement.dispose();
        return { kind: 'unavailable', ...EVENT_OBSERVER_BINDING_UNAVAILABLE };
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
        const seed = params.initialSetupSeed;
        if (seed && (!arePluginContributionIdentitiesEqual(seed.eventRef, initial.event.event.identity)
            || (seed.monitoringMachineId !== undefined && seed.monitoringMachineId !== initial.origin.machineTarget.target.machineId))) return { kind: 'unavailable', reason: 'invalid_seed' };
        const customSetupSurface = initial.event.setupSurface?.selectedRenderer.availability.state === 'available';
        if ((params.requireNativeRenderer || params.savedSourceRendererInput) && !customSetupSurface) return { kind: 'unavailable' };
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
            expectedOccurrenceId: initial.event.setupAction.occurrenceId,
            ...(seed ? {
                draft: seed.setupInput,
                connectedAccount: seed.connectedAccount,
                allowSchemaDeclaredDraftFields: true,
                ...(customSetupSurface ? { allowRendererOnlyDraftFields: true } : {}),
            } : {}),
        });
        const settled = selection.kind === 'form'
            ? await (async () => {
                try {
                    if (customSetupSurface) {
                        const retainedInput = params.initialSource?.sourceConfig;
                        const initialInput = params.savedSourceRendererInput
                            ? PluginUiJsonValueV1Schema.safeParse({
                                ...(isSetupSurfaceObjectInput(retainedInput) ? retainedInput : {}),
                                ...params.savedSourceRendererInput,
                            }) : seed ? PluginUiJsonValueV1Schema.safeParse({
                                ...(isSetupSurfaceObjectInput(retainedInput) ? retainedInput : {}),
                                ...seed.setupInput,
                                ...selection.form.getInput(),
                                ...params.nativeSetupDraft,
                            }) : params.initialSource ? PluginUiJsonValueV1Schema.safeParse(retainedInput) : null;
                        if (initialInput && !initialInput.success) {
                            selection.form.cancel();
                            return { kind: 'unavailable', reason: 'invalid_input' } as const;
                        }
                        const surfaceSettlement = await (
                            params.presentSetupSurface ?? presentPluginEventAutomationSetupSurface
                        )({
                            eligibleEvent: initial.event,
                            projection: initial.inputs,
                            machineId: initial.origin.machineTarget.target.machineId,
                            serverId: initial.origin.machineTarget.serverId,
                            accountLifetime: params.accountLifetime,
                            commandBridge: params.commandBridge,
                            watcherChoices: params.watcherChoices,
                            canChooseWatcher: params.canChooseWatcher,
                            launchInput: {
                                observerMachineId: initial.origin.machineTarget.target.machineId,
                                ...(initialInput?.success ? { initialInput: initialInput.data } : {}),
                            },
                            ...(params.surfaceHeading ? { heading: params.surfaceHeading } : {}),
                            ...(operationScope.signal ? { signal: operationScope.signal } : {}),
                        });
                        if (surfaceSettlement.kind === 'superseded') {
                            const currentInput = initialInput?.success && isSetupSurfaceObjectInput(initialInput.data)
                                ? initialInput.data : selection.form.getInput();
                            selection.form.replaceInput({ ...currentInput, rendererDraft: surfaceSettlement.draft });
                            const input = selection.form.getInput();
                            selection.form.cancel();
                            return { kind: 'superseded', machineId: surfaceSettlement.machineId, input } as const;
                        }
                        if (surfaceSettlement.kind === 'cancelled') {
                            selection.form.cancel();
                            return await selection.result;
                        }
                        const candidate = surfaceSettlement.input;
                        if (!isSetupSurfaceObjectInput(candidate)) {
                            selection.form.cancel();
                            return { kind: 'unavailable', reason: 'invalid_input' } as const;
                        }
                        params.onApplying?.();
                        selection.form.replaceInput(candidate);
                        const submitted = await selection.form.submit();
                        if (submitted.kind !== 'settled' || !submitted.outcome.ok) {
                            selection.form.cancel();
                            return { kind: 'unavailable', reason: 'invalid_input' } as const;
                        }
                        return await selection.result;
                    }
                    const saved = params.initialSource;
                    if (saved) {
                        const sourceConfig: Readonly<Record<string, unknown>> =
                            isSetupSurfaceObjectInput(saved.sourceConfig) ? saved.sourceConfig : {};
                        const retainedInput = { ...sourceConfig, sourceInstanceId: saved.sourceInstanceId };
                        let draft = selection.form.getInput();
                        for (const field of selection.form.presentation.inputHints.fields) {
                            if (readInputPath(seed?.setupInput, field.path) !== undefined
                                || (seed?.connectedAccount && field.connectedAccountOptions)) continue;
                            let value = readInputPath(retainedInput, field.path);
                            // Watch stores the sampling period in milliseconds and edits it in whole seconds.
                            if (value === undefined && field.path === 'checkPeriodSeconds'
                                && typeof sourceConfig.checkPeriodMs === 'number' && Number.isInteger(sourceConfig.checkPeriodMs / 1_000)) {
                                value = sourceConfig.checkPeriodMs / 1_000;
                            }
                            if (value !== undefined) draft = writeInputPath(draft, field.path, value);
                        }
                        selection.form.replaceInput(draft);
                    }
                    (params.present ?? presentActionInputForm)({
                        form: selection.form,
                        signal: operationScope.signal,
                        actionId: formatQualifiedPluginActionId(initial.event.setupAction.identity),
                        pickerContext: {
                            machineId: initial.actionSnapshot.host.machineId,
                            serverId: initial.actionSnapshot.host.serverId,
                            accountLifetime: params.accountLifetime,
                        },
                    });
                    return await selection.result;
                } finally {
                    selection.form.retire();
                }
            })()
            : selection.kind === 'direct'
                ? selection.result
                : selection;
        if (settled.kind === 'cancelled') return { kind: 'cancelled' };
        if (settled.kind === 'superseded') return settled;
        if (settled.kind !== 'submitted') return { kind: 'unavailable' };
        if (operationScope.signal.aborted) return { kind: 'unavailable' };

        const current = await load(initial.origin);
        if ('kind' in current) return current;
        actionSnapshotRef.current = current.actionSnapshot;
        if (
            !arePluginEventAutomationEligibleSetupPresentationsEqual(current.event, initial.event)
            || !areFreshPluginMachineExecutionOriginsCurrent(current.origin, initial.origin)
        ) {
            return { kind: 'stale', reason: 'event_retired' };
        }
        const input = reconstructPluginUiSelectedActionInput(settled);
        if (!input || operationScope.signal.aborted) return { kind: 'unavailable' };
        const dispatch = params.dispatch ?? dispatchPluginSurfaceAction;
        const requestId = randomUUID();
        const outcome = await dispatch({
            action: current.event.setupAction.identity,
            actionRequestId: requestId,
            input,
            resolveContributedAction: current.actionSnapshot.resolveContributedAction,
            contributedAction: {
                machineId: current.origin.machineTarget.target.machineId,
                serverId: current.origin.machineTarget.serverId,
            },
            signal: operationScope.signal,
            isCurrent: current.actionSnapshot.host.isCurrent,
        });
        if (operationScope.signal.aborted) return { kind: 'unavailable' };
        if (!outcome.ok) {
            return {
                kind: 'unavailable',
                code: outcome.code,
                reason: outcome.reason,
                requestId: outcome.requestId ?? requestId,
                ...(outcome.message === undefined ? {} : { message: outcome.message }),
                ...(outcome.details === undefined ? {} : { details: outcome.details }),
                ...(outcome.failureCause === undefined ? {} : { failureCause: outcome.failureCause }),
                ...(outcome.effectAttempted === undefined ? {} : { effectAttempted: outcome.effectAttempted }),
                ...(outcome.retryable === undefined ? {} : { retryable: outcome.retryable }),
                ...(outcome.remediation === undefined ? {} : { remediation: outcome.remediation }),
            };
        }
        const source = validatePluginEventAutomationSetupResult({
            eligibleEvent: current.event,
            result: outcome.result,
        });
        if (source.kind !== 'available') return { kind: 'unavailable' };
        const webhookEndpointResult = params.observationTransport === 'durablePush' || source.result.webhookDelivery !== undefined
            ? await (params.ensureWebhookEndpoint ?? ensurePluginEventAutomationWebhookEndpoint)({
                eligibleEvent: current.event,
                origin: current.origin,
                sourceInstanceId: source.result.sourceInstanceId,
                accountLifetime: params.accountLifetime,
                signal: operationScope.signal,
            })
            : null;
        if (operationScope.signal.aborted) return { kind: 'unavailable' };
        const webhookEndpointUnavailable = webhookEndpointResult?.kind === 'unavailable';
        if (webhookEndpointUnavailable && (params.observationTransport === 'durablePush' || source.result.webhookDelivery === 'required')) {
            return { kind: 'unavailable', code: 'webhook_endpoint_unavailable', reason: 'webhook_endpoint_unavailable' };
        }
        const webhookEndpoint = webhookEndpointResult?.kind === 'available' ? webhookEndpointResult.endpoint : null;
        // The setup Action's delivery intent selects the existing push arm,
        // retaining the very same selected origin as its endpoint target.
        const selectsDurablePush = params.observationTransport === 'durablePush'
            || (source.result.webhookDelivery !== undefined
                && supportsPluginEventAutomationObservationTransport(current.event, 'durablePush'));
        const draft = createPluginEventAutomationAuthoringDraft({
            eligibleEvent: current.event,
            setupResult: source.result,
            watcherOrigin: current.origin.origin,
            observation: selectsDurablePush && webhookEndpoint
                ? { kind: 'durablePush', webhookEndpointId: webhookEndpoint.webhookEndpointId }
                : params.observationTransport === 'socket'
                    ? { kind: 'socket' }
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
            webhookEndpoint,
            ...(webhookEndpointUnavailable ? { webhookEndpointUnavailable: true as const } : {}),
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
