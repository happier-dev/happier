import * as React from 'react';
import type { Disposable } from '@happier-dev/plugin-sdk';
import type { BaseModalConfig } from '@/modal/types';

import { buildQualifiedPluginContributionKey, type PluginContributionIdentityV1 } from '@happier-dev/protocol/plugins/contribution-identity';
import { formatQualifiedPluginActionId, parseQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import { UiContributedActionExecuteRequestV1Schema, UiContributedActionExecuteResponseV1Schema } from '@happier-dev/protocol/plugins/actions/clientInvocationV1';
import type { MessageActionReferenceV1 } from '@happier-dev/protocol/sessions/messages/messageActionReferenceV1';
import { PLUGIN_ACTION_OUTCOME_UNKNOWN_CODE } from '@happier-dev/protocol/plugins/actions/invocation';
import type { ActionDefinitionSummaryV1 } from '@happier-dev/protocol/actions/actionDefinitionV1';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ActionExecutorContext, ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import type { AccountHomeContinuationInputV1 } from '@happier-dev/protocol/actions';
import { voiceDictationOperation, type VoiceDictationActionId } from '@happier-dev/protocol/actions/voiceConversationActionFamily';
import { PluginJsonValueV2Schema, type PluginJsonSchemaV2 } from '@happier-dev/protocol/plugins/contributions/jsonSchema';
import type { PluginProjectedActionV2 } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import type {
    PluginUiJsonValueV1,
} from '@happier-dev/protocol/plugins/ui';

import { createAppShellClientActionAdmissionSource, useAppShellPluginUiProjectionSubscription } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import {
    usePluginSurfaceDestinationNavigationBinding,
    type PluginSurfaceDestinationNavigationBinding,
} from '@/components/plugins/surfaces/pluginSurfaceDestinationNavigation';
import {
    dispatchPluginSurfaceAction,
    isPluginSurfaceClientActionOccurrencePinned,
    type PluginSurfaceHostActionBinding,
    type PluginSurfaceHostActionExecute,
    type PluginSurfaceActionInvocationSurface,
    type DispatchPluginSurfaceActionInput,
    type PluginSurfaceActionDispatchOutcome,
} from '@/components/plugins/surfaces/pluginSurfaceActionDispatch';
import type { PluginUiClientActionAdmissionSource } from '@/components/plugins/reactNative/clientActionAdmission';
import { observeCurrentContributedAction } from './contributedActionObservation';
import {
    createPluginUiProjectedActionResolver,
    isPluginProjectedActionExecutable,
    type PluginUiProjectionModel,
    type PluginUiActionProjection,
} from '@/sync/domains/plugins/ui/projection';
import { readCurrentAppShellPluginUiProjection } from '@/components/appShell/plugins/committedPluginUiProjection';
import { projectedActionToDefinition } from './contributedActionDefinition';
import { machinePluginActionSchemasRead } from '@/sync/ops/machineContributionRegistryProjection';
import { readPluginAccountAvailability } from '@/sync/domains/plugins/availability/projection';
import { registerCurrentUiContextActionPort } from './currentUiContextActionRuntime';
import { useCurrentUiContextCommandBridge } from './CurrentUiContextCommands';
import { mergeAbortSignals } from '@/utils/runtime/abortSignals';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { readPluginUiAccountExecutableOrigin } from '@/sync/domains/plugins/ui/projectionOrigins';
import { PluginActionSurfaceV2Schema } from '@happier-dev/protocol/plugins/actions/v2';
import { unavailable } from './currentUiContextVoiceToolBinding';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import { areServerProfileIdentifiersEquivalent, resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { resolveCurrentContributedAction as resolveCurrentAction, isResolvedContributedActionCurrent as isResolvedActionCurrent,
    acquireCurrentContributedAction,
    type CurrentContributedAction as CurrentUiContextVoiceResolvedAction } from './contributedActionInvocation';
export { bindCurrentUiContextVoiceToolPortToAdmission } from './currentUiContextVoiceToolBinding';

import {
    useOptionalCurrentUiContextReader,
    type CurrentUiContextReader,
    type CurrentUiContextResolvedCommand,
} from './CurrentUiContextProvider';

/**
 * The bounded settlement that the current-UI owner can give a Voice effect.
 * It deliberately omits the resolved semantic command, its input, and host
 * diagnostics: those remain local to the current-context and Action owners.
 */
export type CurrentUiContextVoiceInvocationOutcome =
    | Readonly<{ ok: true; result?: PluginUiJsonValueV1; commandTitle?: string }>
    | Readonly<{ ok: false; code: Extract<PluginSurfaceActionDispatchOutcome, { ok: false }>['code'] | 'outcome_unknown'; errorCode?: string; actionHandlerInvocation?: 'notStarted';
        message?: Extract<PluginSurfaceActionDispatchOutcome, { ok: false }>['message'];
        retryable?: Extract<PluginSurfaceActionDispatchOutcome, { ok: false }>['retryable'];
        remediation?: Extract<PluginSurfaceActionDispatchOutcome, { ok: false }>['remediation'];
        details?: Extract<PluginSurfaceActionDispatchOutcome, { ok: false }>['details'];
        requestId?: Extract<PluginSurfaceActionDispatchOutcome, { ok: false }>['requestId'];
        effectAttempted?: Extract<PluginSurfaceActionDispatchOutcome, { ok: false }>['effectAttempted'];
        failureCause?: Extract<PluginSurfaceActionDispatchOutcome, { ok: false }>['failureCause'] }>;

export type CurrentUiContextVoiceCommandInvocationInput = Readonly<{
    commandId: string;
    includeCommandTitle?: true;
    input?: PluginUiJsonValueV1;
    signal?: AbortSignal;
    /** Host-private Settings ingress retains its admitted caller through the same mounted command. */
    context?: ActionExecutorContext;
    spokenActionRequest?: DispatchPluginSurfaceActionInput['spokenActionRequest'];
}>;

export type CurrentUiContextVoiceActionInvocationInput = Readonly<{
    action: PluginContributionIdentityV1;
    spokenActionRequest?: DispatchPluginSurfaceActionInput['spokenActionRequest'];
    input?: PluginUiJsonValueV1;
    messageActionReference?: MessageActionReferenceV1;
    signal?: AbortSignal;
    expectedContributorOccurrenceId?: string;
    defaultSessionId?: string;
    requiredDangerLevel?: 'safe';
}>;

/**
 * The client-local current-context port carried into a Voice attempt. The
 * reader is sufficient for explicit reads; the optional effect members are
 * supplied only by the AppShell bridge that can delegate to the incumbent
 * navigation and Action owners. No consumer can recover semantic payloads
 * from an opaque command ID through this type.
 */
/** One contributed Action's declared schemas, read on demand (never listed). */
export type CurrentUiContextVoiceActionSchemas = Readonly<{
    inputSchema: PluginJsonSchemaV2;
    outputSchema?: PluginJsonSchemaV2;
}>;

export type CurrentUiContextVoiceToolPort = CurrentUiContextReader & Readonly<{
    /** Host-private React composition for client dialogs opened by an Action. */
    commandBridge?: BaseModalConfig['commandBridge'];
    invokeVoiceDictation?: (request: Readonly<{ actionId: VoiceDictationActionId; input: Readonly<{ commandId: string }>; context: ActionExecutorContext }>) => Promise<ActionExecuteResult>;
    /** Only the ordinary typed Action may reach this admitted mounted effect. */
    invokeAccountHomeContinuation?: (request: Readonly<{ input: AccountHomeContinuationInputV1; context: ActionExecutorContext }>) => Promise<ActionExecuteResult>;
    listCurrentContributedActionDefinitions?: (
        selection?: 'allSurfaces',
        exact?: Parameters<NonNullable<ActionExecutorDeps['listContributedActionDefinitions']>>[0],
    ) => readonly ActionDefinitionSummaryV1[];
    readCurrentContributedActionSchemas?: (
        id: string,
        signal?: AbortSignal,
    ) => Promise<CurrentUiContextVoiceActionSchemas | null>;
    invokeCurrentUiCommand?: (
        input: CurrentUiContextVoiceCommandInvocationInput,
    ) => Promise<CurrentUiContextVoiceInvocationOutcome>;
    invokeAction?: (
        input: CurrentUiContextVoiceActionInvocationInput,
    ) => Promise<CurrentUiContextVoiceInvocationOutcome>;
    /** Ordinary host dependency observation, not a Voice-attempt capability. */
    observeAction?: (input: CurrentUiContextVoiceActionInvocationInput & Readonly<{
        invalidate(): void;
        isCurrent(): boolean;
    }>) => Promise<Disposable>;
}>;

type CurrentUiContextVoiceToolPortInput = Readonly<{
    commandBridge?: BaseModalConfig['commandBridge'];
    /** Voice callers omit this; ordinary host Actions retain their real surface. */
    invocationSurface?: PluginSurfaceActionInvocationSurface;
    hostAction?: PluginSurfaceHostActionBinding;
    reader: CurrentUiContextReader;
    /** Reads the latest AppShell projection at an effect boundary. */
    readProjection: () => PluginUiProjectionModel | null;
    clientExecutableAdmission?: PluginUiClientActionAdmissionSource;
    /** Reads the incumbent app-target navigation binding at an effect boundary. */
    readNavigationBinding: () => PluginSurfaceDestinationNavigationBinding | null;
}>;

function stale(): CurrentUiContextVoiceInvocationOutcome {
    return { ok: false, code: 'stale_surface' };
}

function internalError(): CurrentUiContextVoiceInvocationOutcome {
    return { ok: false, code: 'internal_error' };
}

function isVoiceListedAction(
    readProjection: () => PluginUiProjectionModel | null,
    action: PluginProjectedActionV2,
): CurrentUiContextVoiceResolvedAction | null {
    if (!isPluginProjectedActionExecutable(action) || !action.surfaces.includes('voice')) return null;
    const resolved = resolveCurrentAction(readProjection, {
        pluginId: action.pluginId,
        localId: action.id,
    });
    return resolved?.action === action ? resolved : null;
}

/**
 * Reads schemas for the exact listed occurrence: admitted Account declaration
 * or the existing projecting-Machine reader. The listing never carries them.
 */
async function readCurrentContributedActionSchemas(
    readProjection: () => PluginUiProjectionModel | null,
    id: string,
    signal: AbortSignal | undefined,
): Promise<CurrentUiContextVoiceActionSchemas | null> {
    if (signal?.aborted) return null;
    const identity = parseQualifiedPluginActionId(id);
    if (!identity) return null;
    const action = createPluginUiProjectedActionResolver(readProjection()?.actionsById)(identity);
    const resolved = action ? isVoiceListedAction(readProjection, action) : null;
    if (!resolved) return null;
    if (resolved.kind === 'account') {
        const lifetime = resolved.accountRegistration.registration.accountLifetime;
        const selected = !resolved.action.accountActionDeclaration && lifetime
            ? await readPluginAccountAvailability(lifetime.scope).ensureCurrentAccountExecution(identity.pluginId) : null;
        if (signal?.aborted || !isResolvedActionCurrent(readProjection, identity, resolved)) return null;
        const declaration = resolved.action.accountActionDeclaration ?? (selected?.kind === 'available'
            && selected.custodyId === resolved.action.occurrenceId
            ? selected.manifest.contributes.actions.find(action => action.id === identity.localId) : undefined);
        return declaration ? Object.freeze({ inputSchema: declaration.inputSchema ?? {},
            ...(declaration.resultSchema === undefined ? {} : { outputSchema: declaration.resultSchema }) }) : null;
    }
    const read = await machinePluginActionSchemasRead(resolved.origin.machineId, {
        serverId: resolved.origin.serverId,
        expectedOccurrenceId: resolved.action.occurrenceId,
        qualifiedActionId: buildQualifiedPluginContributionKey(identity),
        ...(signal ? { signal } : {}),
    });
    if (!read.supported || !read.result.ok) return null;
    return Object.freeze({
        inputSchema: read.result.inputSchema ?? {},
        ...(read.result.outputSchema === undefined ? {} : { outputSchema: read.result.outputSchema }),
    });
}

function listCurrentContributedActionDefinitions(
    readProjection: () => PluginUiProjectionModel | null,
    surface: PluginSurfaceActionInvocationSurface | 'allSurfaces' = 'voice',
    selection?: Parameters<NonNullable<ActionExecutorDeps['listContributedActionDefinitions']>>[0],
): readonly ActionDefinitionSummaryV1[] {
    const projection = readProjection();
    if (!projection) return [];
    const readSnapshot = () => projection;
    const identity = selection ? parseQualifiedPluginActionId(selection.id) : null;
    const selected = identity ? createPluginUiProjectedActionResolver(projection.actionsById)(identity) : null;
    const actions = selection ? selected ? [selected] : [] : Object.values(projection.actionsById);
    return actions
        .filter((action) => {
            if (surface === 'voice') return isVoiceListedAction(readSnapshot, action) !== null;
            if (!isPluginProjectedActionExecutable(action) || surface !== 'allSurfaces' && !action.surfaces.includes(surface)) return false;
            const resolved = resolveCurrentAction(readSnapshot, { pluginId: action.pluginId, localId: action.id });
            return resolved !== null;
        })
        .map((action) => projectedActionToDefinition(action, projection))
        .sort((left, right) => left.id.localeCompare(right.id));
}

/**
 * The opaque ID is valid only while this exact private command record remains
 * the provider-local current record. It is deliberately a data/currentness
 * comparison, never a retained callback or an independently-owned registry.
 */
function isResolvedCommandCurrent(
    reader: CurrentUiContextReader,
    resolved: CurrentUiContextResolvedCommand,
): boolean {
    const current = reader.resolveCurrentUiCommand(resolved.id);
    return current !== null
        && current.id === resolved.id
        && current.command === resolved.command;
}

/**
 * AppShell-side bridge for the provider-local current-context reader. It owns
 * no navigation state or Action policy: opaque commands are re-resolved at the
 * reader and then delegated to the incumbent navigation/Action owners.
 */
export function createCurrentUiContextVoiceToolPort(
    providedInput: CurrentUiContextVoiceToolPortInput,
): CurrentUiContextVoiceToolPort {
    const context = providedInput.hostAction?.context;
    const scope = context?.serverId && context.expectedAccountId ? {
        serverId: resolveServerProfileScopeIdForIdentifier(context.serverId), accountId: context.expectedAccountId,
    } : null;
    // A mounted reader supplies presentation, never a substitute Account or
    // Action origin for a host invocation that already captured its scope.
    const input = scope ? { ...providedInput,
        readProjection: () => readCurrentAppShellPluginUiProjection({ scope, declarationsOnly: true }),
    } : providedInput;
    const invokeProjectedAction = async (
        request: CurrentUiContextVoiceActionInvocationInput,
        isCallerCurrent: () => boolean,
        includeCurrentUiContext: boolean,
        readObservation?: DispatchPluginSurfaceActionInput['readObservation'],
        onInvocationAdmitted?: DispatchPluginSurfaceActionInput['onInvocationAdmitted'],
    ): Promise<CurrentUiContextVoiceInvocationOutcome> => {
        if (request.signal?.aborted) return unavailable();
        // One-shot catalog reads can arrive before their Account executable.
        // Join the same push-driven startup settlement as observed reads.
        const resolved = await acquireCurrentContributedAction({ readProjection: input.readProjection,
            identity: request.action, admission: input.clientExecutableAdmission, scope,
            signal: request.signal, isCurrent: isCallerCurrent });
        if (!resolved) return unavailable();
        if (request.expectedContributorOccurrenceId !== undefined && request.expectedContributorOccurrenceId !== resolved.action.occurrenceId) {
            return { ok: false, code: 'stale_surface', errorCode: 'plugin_action_generation_retired', actionHandlerInvocation: 'notStarted' };
        }
        const resource = input.hostAction?.context?.resourceActionInvocation;
        const retainedInvocation = input.hostAction?.context?.contributedActionInvocation;
        const occurrenceBinding = {
            ...retainedInvocation?.caller,
            expectedContributorOccurrenceId: request.expectedContributorOccurrenceId,
            hostAction: input.hostAction,
            resourceCaller: resource?.resourceCaller,
            contributedAction: retainedInvocation?.contributedAction,
        };
        const followsAccountPublication = resolved.action.execution.target === 'client'
            && !isPluginSurfaceClientActionOccurrencePinned(occurrenceBinding);
        const admittedAccountLifetime = followsAccountPublication
            ? retainedInvocation?.caller.actionAccountLifetime ?? input.clientExecutableAdmission?.read()?.accountLifetime
            : undefined;
        const actionAccountLifetime = admittedAccountLifetime
            && (!scope || areServerAccountScopesEqual(scope, admittedAccountLifetime.scope))
            ? admittedAccountLifetime : undefined;
        const serverId = followsAccountPublication
            ? actionAccountLifetime?.scope.serverId ?? scope?.serverId : resolved.origin.serverId;
        const currentSessionId = input.reader.readCurrentSessionId?.() ?? null;
        const sessionId = request.defaultSessionId ?? request.messageActionReference?.sessionId ?? currentSessionId;
        // Only an implicit viewed-Session binding retires on navigation. An
        // explicitly invoking Session (or a global Action) does not borrow it.
        const followsViewedSession = includeCurrentUiContext
            || ((input.invocationSurface ?? 'voice') === 'voice'
                && request.defaultSessionId === undefined && resolved.action.scopes.includes('session'));
        // Observe this invocation through the existing committed-context owner.
        // Equality alone would revive an old binding after Session A → B → A.
        const sessionRetirement = new AbortController();
        const checkSession = () => {
            if (followsViewedSession && (input.reader.readCurrentSessionId?.() ?? null) !== currentSessionId) sessionRetirement.abort();
        };
        const unsubscribe = input.reader.subscribe(checkSession);
        const mergedSignal = mergeAbortSignals([sessionRetirement.signal, request.signal]);
        checkSession();
        const isCurrent = (): boolean => (
            !mergedSignal.signal.aborted
            && (!followsViewedSession || (input.reader.readCurrentSessionId?.() ?? null) === currentSessionId)
            && isCallerCurrent()
            && (actionAccountLifetime?.isCurrent() !== false)
            && (followsAccountPublication || isResolvedActionCurrent(input.readProjection, request.action, resolved))
        );
        if (!isCurrent()) {
            unsubscribe();
            mergedSignal.dispose();
            return stale();
        }
        const openSurface = async (surfaceRequest: Parameters<PluginSurfaceDestinationNavigationBinding['openSurface']>[0]) => {
            if (!isCurrent()) {
                return { ok: false as const, code: 'stale_surface' as const, reason: 'current_ui_action_retired' };
            }
            const navigation = input.readNavigationBinding();
            if (!navigation) {
                return { ok: false as const, code: 'unavailable' as const, reason: 'current_ui_navigation_unavailable' };
            }
            if (!isCurrent()) {
                return { ok: false as const, code: 'stale_surface' as const, reason: 'current_ui_action_retired' };
            }
            try {
                const outcome = await navigation.openSurface(surfaceRequest);
                return outcome;
            } catch {
                return isCurrent()
                    ? { ok: false as const, code: 'internal_error' as const, reason: 'current_ui_navigation_failed' }
                    : { ok: false as const, code: 'stale_surface' as const, reason: 'current_ui_action_retired' };
            }
        };
        try {
            const origin = PluginActionSurfaceV2Schema.safeParse(input.hostAction?.context?.actionCaller?.kind === 'plugin'
                ? input.hostAction.context.actionCaller.originSurface : undefined);
            const outcome = await dispatchPluginSurfaceAction({
                action: request.action,
                ...(request.spokenActionRequest ? { spokenActionRequest: request.spokenActionRequest } : {}),
                ...(input.hostAction?.context?.invocationServices?.connectedAccountPurposeBinding
                    ? { connectedAccountPurposeBinding: input.hostAction.context.invocationServices.connectedAccountPurposeBinding } : {}),
                ...(input.hostAction?.context?.invocationServices?.managedBootstrapCredential
                    ? { managedBootstrapCredential: input.hostAction.context.invocationServices.managedBootstrapCredential } : {}),
                ...(request.input === undefined ? {} : { input: request.input }),
                ...retainedInvocation?.caller,
                expectedContributorOccurrenceId: request.expectedContributorOccurrenceId,
                ...(actionAccountLifetime ? { actionAccountLifetime, readPluginUiProjection: input.readProjection } : {}),
                settleContributedAction: actionAccountLifetime ? async (identity, { signal }) => {
                    const current = await acquireCurrentContributedAction({ readProjection: input.readProjection,
                        identity, admission: input.clientExecutableAdmission, scope, signal, isCurrent });
                    return current ? { ok: true, binding: undefined } : {
                        ok: false, code: 'unavailable', reason: 'plugin_surface_client_action_unavailable',
                        actionHandlerInvocation: 'notStarted',
                    };
                } : undefined,
                ...(onInvocationAdmitted ? { onInvocationAdmitted } : {}),
                ...(resource ? { resourceCaller: resource.resourceCaller,
                    callerPluginId: resource.resourceCaller?.pluginId,
                    requiredReadOnly: resource.requiredReadOnly, readObservation: resource.readObservation } : {}),
                ...(readObservation ? { requiredReadOnly: true, readObservation } : {}),
                requiredDangerLevel: request.requiredDangerLevel,
                resolveContributedAction: (identity) => (
                    createPluginUiProjectedActionResolver(input.readProjection()?.actionsById)(identity)
                ),
                invocationSurface: input.invocationSurface ?? 'voice',
                ...(origin.success && origin.data !== 'plugin' ? { originSurface: origin.data } : {}),
                hostAction: {
                    execute: input.hostAction?.execute ?? createFrontDoorActionExecute(),
                    context: { ...input.hostAction?.context,
                        ...(input.hostAction?.context?.sessionTargetsV1 ? {} : serverId ? { serverId } : {}),
                        ...(sessionId ? { defaultSessionId: sessionId } : {}),
                    },
                },
                pluginUiProjection: input.readProjection(),
                clientAction: retainedInvocation?.clientAction ?? {
                    ...(sessionId ? { sessionId } : {}),
                    ...(request.messageActionReference ? { messageActionReference: request.messageActionReference } : {}),
                    openSurface,
                    ...(includeCurrentUiContext
                        ? {
                            currentUiContext: () => isCurrent()
                                ? input.reader.readCurrentUiContext()
                                : null,
                        }
                        : {}),
                },
                ...(resolved.kind === 'machine' && resolved.action.execution.target === 'daemon'
                    ? {
                        contributedAction: retainedInvocation?.contributedAction ?? {
                            ...(sessionId ? { sessionId } : {}),
                            ...(request.messageActionReference ? { messageActionReference: request.messageActionReference } : {}),
                            machineId: resolved.origin.machineId,
                            serverId: resolved.origin.serverId,
                        },
                    }
                    : {}),
                signal: resource ? resource.signal : retainedInvocation?.signal ?? mergedSignal.signal,
                isCurrent: () => isCurrent() && resource?.isCurrent?.() !== false && retainedInvocation?.isCurrent?.() !== false,
            });
            if (outcome.ok) return { ok: true, result: outcome.result };
            const requestId = outcome.requestId ?? input.hostAction?.context?.actionRequestId;
            const author = {
                ...(outcome.message === undefined ? {} : { message: outcome.message }),
                ...(outcome.retryable === undefined ? {} : { retryable: outcome.retryable }),
                ...(outcome.remediation === undefined ? {} : { remediation: outcome.remediation }),
                ...(outcome.details === undefined ? {} : { details: outcome.details }),
                ...(requestId === undefined ? {} : { requestId }),
                ...(outcome.effectAttempted === undefined ? {} : { effectAttempted: outcome.effectAttempted }),
                ...(outcome.failureCause === undefined ? {} : { failureCause: outcome.failureCause }),
            };
            if (outcome.reason === 'plugin_ui_action_outcome_unknown') {
                // An issued effect remains indeterminate even if its UI binding
                // retired while the acknowledgement was lost. Voice custody
                // retains this canonical terminal result by stable effect ID.
                return { ok: false, code: 'outcome_unknown', ...author };
            }
            return { ok: false, code: outcome.code, errorCode: outcome.reason, ...author,
                ...(outcome.actionHandlerInvocation ? { actionHandlerInvocation: outcome.actionHandlerInvocation } : {}) };
        } catch {
            return isCurrent() ? internalError() : stale();
        } finally {
            unsubscribe();
            mergedSignal.dispose();
        }
    };

    const invokeAction = async (
        request: CurrentUiContextVoiceActionInvocationInput,
    ): Promise<CurrentUiContextVoiceInvocationOutcome> => (
        invokeProjectedAction(request, () => true, false)
    );

    const observeAction: NonNullable<CurrentUiContextVoiceToolPort['observeAction']> = request => observeCurrentContributedAction({
        request, readProjection: input.readProjection, admission: input.clientExecutableAdmission, scope,
        invoke: (observation, signal, isCurrent) => invokeProjectedAction({ ...request, signal }, isCurrent, false, observation),
    });

    const invokeResolvedCurrentUiCommand = async (
        request: CurrentUiContextVoiceCommandInvocationInput,
        resolved: CurrentUiContextResolvedCommand,
    ): Promise<CurrentUiContextVoiceInvocationOutcome> => {
        const isCurrent = (): boolean => (
            request.signal?.aborted !== true
            && isResolvedCommandCurrent(input.reader, resolved)
        );
        if (!isCurrent()) return stale();

        // This parameterized command is consumed only by its typed origin Actions.
        if (resolved.command.kind === 'pluginExecutionOrigin') return unavailable();

        if (resolved.command.kind === 'voiceDictation') {
            const command = resolved.command;
            const mergedSignal = mergeAbortSignals([resolved.retirementSignal, request.signal]);
            try {
                const execute = input.hostAction?.execute ?? (async (...args: Parameters<PluginSurfaceHostActionExecute>) => {
                    const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
                    return createDefaultActionExecutor().execute(...args);
                });
                if (!isCurrent() || !command.account.isCurrent()) return stale();
                const result = await execute(`ui.voice_global.dictation.${command.operation}`, { commandId: resolved.id }, {
                    ...input.hostAction?.context, surface: input.invocationSurface ?? 'voice', signal: mergedSignal.signal,
                });
                if (!result.ok) return { ok: false, code: 'denied', errorCode: result.errorCode };
                const payload = PluginJsonValueV2Schema.safeParse(result.result ?? null);
                return payload.success ? { ok: true, result: payload.data } : internalError();
            } finally { mergedSignal.dispose(); }
        }

        if (resolved.command.kind === 'accountHomeContinuation') {
            const command = resolved.command;
            const mergedSignal = mergeAbortSignals([resolved.retirementSignal, request.signal]);
            try {
                const execute = input.hostAction?.execute ?? (async (...args: Parameters<PluginSurfaceHostActionExecute>) => {
                    const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
                    return await createDefaultActionExecutor().execute(...args);
                });
                if (!isCurrent() || !command.account.isCurrent()) return stale();
                const result = await execute('account.home_continuation.invoke', {
                    commandId: resolved.id, operation: command.operation,
                    ...(command.operation === 'choose' ? { homeServerIdentityId: command.homeServerIdentityId } : {}),
                }, { ...input.hostAction?.context, surface: input.invocationSurface ?? 'voice', signal: mergedSignal.signal });
                if (!result.ok) return { ok: false, code: 'denied', errorCode: result.errorCode };
                const payload = PluginJsonValueV2Schema.safeParse(result.result ?? null);
                return payload.success ? { ok: true, result: payload.data } : internalError();
            } finally { mergedSignal.dispose(); }
        }

        if (resolved.command.kind === 'hostLocal') {
            const mergedSignal = mergeAbortSignals([resolved.retirementSignal, request.signal]);
            try {
                if (!isCurrent() || mergedSignal.signal.aborted) return stale();
                // The local update may itself republish this mount. Preserve
                // its known settlement; the callback fences its effect boundary.
                return await resolved.command.invoke({ signal: mergedSignal.signal,
                    context: request.context ?? input.hostAction?.context ?? { surface: input.invocationSurface ?? 'voice' },
                    ...(request.input === undefined ? {} : { input: request.input }) });
            } catch {
                return isCurrent() ? internalError() : stale();
            } finally {
                mergedSignal.dispose();
            }
        }

        if (resolved.command.kind === 'executeAction') {
            const admission = new AbortController();
            const retire = () => admission.abort(resolved.retirementSignal.reason);
            const releaseRetirement = () => resolved.retirementSignal.removeEventListener('abort', retire);
            resolved.retirementSignal.addEventListener('abort', retire, { once: true });
            if (resolved.retirementSignal.aborted) retire();
            const mergedSignal = mergeAbortSignals([admission.signal, request.signal]);
            try {
                const actionInput = resolved.command.input === undefined ? request.input : resolved.command.input;
                return await invokeProjectedAction({
                    action: resolved.command.action,
                    ...(request.spokenActionRequest ? { spokenActionRequest: request.spokenActionRequest } : {}),
                    ...(actionInput === undefined ? {} : { input: actionInput }),
                    signal: mergedSignal.signal,
                }, isCurrent, true, undefined, releaseRetirement);
            } finally {
                releaseRetirement();
                mergedSignal.dispose();
            }
        }

        const navigation = input.readNavigationBinding();
        if (!navigation) return unavailable();
        // The binding lookup itself can cross a render/currentness boundary;
        // the final re-resolution is immediately before the outward effect.
        if (!isCurrent()) return stale();
        try {
            const outcome = await navigation.openSurface({
                destination: resolved.command.destination,
                ...(resolved.command.input === undefined ? {} : { input: resolved.command.input }),
                ...(resolved.command.subPath === undefined ? {} : { subPath: resolved.command.subPath }),
                ...(resolved.command.instanceKey === undefined ? {} : { instanceKey: resolved.command.instanceKey }),
                ...(resolved.command.presentation === undefined ? {} : { presentation: resolved.command.presentation }),
            });
            // A known success remains authoritative even if the publishing
            // mount retires while navigation settles. The same holds for a
            // known failure: rewriting either result would make the incumbent
            // Voice barrier invite a blind retry.
            if (outcome.ok) return { ok: true };
            return { ok: false, code: outcome.code };
        } catch {
            return isCurrent() ? { ok: false, code: 'internal_error' } : stale();
        }
    };

    const invokeCurrentUiCommand: NonNullable<CurrentUiContextVoiceToolPort['invokeCurrentUiCommand']> = async request => {
        if (request.signal?.aborted) return unavailable();
        const resolved = input.reader.resolveCurrentUiCommand(request.commandId);
        if (!resolved) return input.reader.readCurrentUiContext() === null
            ? unavailable()
            : { ok: false, code: 'unavailable', errorCode: 'unsupported_action' };
        const outcome = await invokeResolvedCurrentUiCommand(request, resolved);
        return request.includeCommandTitle && outcome.ok && resolved.title
            ? { ...outcome, commandTitle: resolved.title }
            : outcome;
    };

    return Object.freeze({
        ...input.reader,
        commandBridge: input.commandBridge,
        invokeVoiceDictation: async (request: Readonly<{ actionId: VoiceDictationActionId; input: Readonly<{ commandId: string }>; context: ActionExecutorContext }>): Promise<ActionExecuteResult> => {
            const resolved = input.reader.resolveCurrentUiCommand(request.input.commandId);
            const command = resolved?.command;
            const unavailable = (): ActionExecuteResult => ({ ok: true, result: { status: 'unavailable', code: 'dictation_field_unmounted' } });
            if (!resolved || command?.kind !== 'voiceDictation' || !isResolvedCommandCurrent(input.reader, resolved)
                || command.operation !== voiceDictationOperation(request.actionId) || !command.account.isCurrent()
                || request.context.signal?.aborted || !request.context.serverId
                || !areServerProfileIdentifiersEquivalent(request.context.serverId, command.account.scope.serverId)
                || (request.context.expectedAccountId ?? request.context.runtimeAccountId) !== command.account.scope.accountId) return unavailable();
            const accountRetirement = new AbortController();
            const retirement = command.account.onRetire(() => accountRetirement.abort());
            const cancellation = mergeAbortSignals([resolved.retirementSignal, request.context.signal, accountRetirement.signal]);
            try {
                if (cancellation.signal.aborted || !isResolvedCommandCurrent(input.reader, resolved)) return unavailable();
                return { ok: true, result: await command.invoke({ signal: cancellation.signal }) };
            } finally { retirement.dispose(); cancellation.dispose(); }
        },
        invokeAccountHomeContinuation: async (request: Readonly<{ input: AccountHomeContinuationInputV1; context: ActionExecutorContext }>): Promise<ActionExecuteResult> => {
            const resolved = input.reader.resolveCurrentUiCommand(request.input.commandId);
            const command = resolved?.command;
            const unavailable = (): ActionExecuteResult => ({ ok: false, errorCode: 'action_account_scope_changed', error: 'current_account_continuation_unavailable' });
            if (!resolved || command?.kind !== 'accountHomeContinuation' || !isResolvedCommandCurrent(input.reader, resolved)
                || !command.account.isCurrent() || request.context.signal?.aborted
                || request.context.authority !== 'present_user'
                || !request.context.serverId || !areServerProfileIdentifiersEquivalent(request.context.serverId, command.account.scope.serverId)
                || (request.context.expectedAccountId ?? request.context.runtimeAccountId) !== command.account.scope.accountId
                || request.input.operation !== command.operation
                || (request.input.operation === 'choose' && (command.operation !== 'choose'
                    || request.input.homeServerIdentityId !== command.homeServerIdentityId))) return unavailable();
            const accountRetirement = new AbortController();
            const retirement = command.account.onRetire(() => accountRetirement.abort());
            const cancellation = mergeAbortSignals([resolved.retirementSignal, request.context.signal, accountRetirement.signal]);
            try {
                if (cancellation.signal.aborted || !command.account.isCurrent()
                    || !isResolvedCommandCurrent(input.reader, resolved)) return unavailable();
                // The same mounted operation settles its own durable result. Its
                // successful publication may retire this descriptor afterwards.
                return { ok: true, result: await command.invoke({ signal: cancellation.signal, context: request.context }) };
            } finally { retirement.dispose(); cancellation.dispose(); }
        },
        listCurrentContributedActionDefinitions: (selection, exact) => (
            listCurrentContributedActionDefinitions(input.readProjection, selection ?? input.invocationSurface ?? 'voice', exact)
        ),
        readCurrentContributedActionSchemas: (id: string, signal?: AbortSignal) => (
            readCurrentContributedActionSchemas(input.readProjection, id, signal)
        ),
        invokeCurrentUiCommand,
        invokeAction,
        observeAction,
    });
}

/**
 * The stable attempt-local port follows current AppShell facts through refs,
 * so an already-created Voice attempt cannot recover a retired projection or
 * navigation binding from a prior render. All reads remain provider-local;
 * the ordinary Action adapter borrows this factory rather than mirroring context.
 */
function useCurrentUiContextToolPortFactory() {
    const reader = useOptionalCurrentUiContextReader();
    const commandBridge = useCurrentUiContextCommandBridge();
    const appShellProjection = useAppShellPluginUiProjectionSubscription();
    const navigationBinding = usePluginSurfaceDestinationNavigationBinding();
    const navigationBindingRef = React.useRef(navigationBinding);
    navigationBindingRef.current = navigationBinding;

    return React.useCallback(
        (invocationSurface: PluginSurfaceActionInvocationSurface, hostAction?: PluginSurfaceHostActionBinding) => reader
            ? createCurrentUiContextVoiceToolPort({
                reader,
                commandBridge,
                invocationSurface,
                hostAction,
                readProjection: () => appShellProjection.getSnapshot().pluginUiProjection,
                clientExecutableAdmission: createAppShellClientActionAdmissionSource(appShellProjection),
                readNavigationBinding: () => navigationBindingRef.current,
            })
            : null,
        [reader, commandBridge, appShellProjection],
    );
}

export function useCurrentUiContextVoiceToolPort(): CurrentUiContextVoiceToolPort | null {
    const createPort = useCurrentUiContextToolPortFactory();
    return React.useMemo(() => createPort('voice'), [createPort]);
}

/** Strict reverse ingress; execution still enters the ordinary Action front door. */
export function createCurrentUiContributedActionRpcHandler(input: Readonly<{
    machineId: string;
    serverId: string;
    accountId?: string;
    readProjection: () => PluginUiProjectionModel | null;
    isCurrent: () => boolean;
    canExecute?: () => boolean;
    execute: PluginSurfaceHostActionExecute;
}>) {
    return async (params: unknown, context?: Readonly<{ signal: AbortSignal }>) => {
        const parsed = UiContributedActionExecuteRequestV1Schema.safeParse(params);
        if (!parsed.success) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters', actionHandlerInvocation: 'notStarted' };
        const request = parsed.data;
        const invokingAccount = request.invokingAccountAction;
        const unavailable = () => ({ ok: false, errorCode: invokingAccount ? 'client_not_available' : 'contributed_action_unavailable',
            error: 'current_ui_action_unavailable', actionHandlerInvocation: 'notStarted' });
        const isCurrent = () => input.isCurrent() && input.canExecute?.() !== false && !context?.signal.aborted;
        if (!isCurrent() || invokingAccount && (request.surface !== 'agent' || invokingAccount.accountId !== input.accountId)) {
            return unavailable();
        }
        let expectedAccountId = invokingAccount?.accountId;
        if (invokingAccount) {
            const action = createPluginUiProjectedActionResolver(input.readProjection()?.actionsById)(request.action);
            const origin = action ? readPluginUiAccountExecutableOrigin(action) : null;
            // The ordinary Action front door acquires this occurrence's App registration.
            if (!action || action.execution.target !== 'account' || !action.execution.agentInvokingUi
                || origin?.accountId !== invokingAccount.accountId || origin.serverId !== input.serverId
                || action.occurrenceId !== request.expectedContributorOccurrenceId) return unavailable();
        } else {
            const resolved = resolveCurrentAction(input.readProjection, request.action);
            if (!resolved || resolved.action.execution.target !== 'client'
                || resolved.action.occurrenceId !== request.expectedContributorOccurrenceId) return unavailable();
            if (resolved.kind === 'account') {
                if (resolved.origin.accountId !== input.accountId
                    || !areServerProfileIdentifiersEquivalent(resolved.origin.serverId, input.serverId)) return unavailable();
                expectedAccountId = resolved.origin.accountId;
            } else if (resolved.origin.machineId !== input.machineId || resolved.origin.serverId !== input.serverId) {
                return unavailable();
            }
        }
        try {
            const requestId = request.actionRequestId;
            const result = await input.execute('action.invoke', { action: request.action, input: request.input,
                ...(request.messageActionReference ? { messageActionReference: request.messageActionReference } : {}) }, {
                surface: request.surface,
                serverId: input.serverId,
                ...(request.actionRequestId ? { actionRequestId: request.actionRequestId } : {}),
                expectedContributedActionOccurrenceId: request.expectedContributorOccurrenceId,
                ...(expectedAccountId ? { expectedAccountId } : {}),
                ...(invokingAccount ? {
                    authority: 'account_automation' as const,
                    actionCaller: invokingAccount.caller,
                    callerPermissionMode: invokingAccount.callerPermissionMode,
                    causalPermissionAuthority: invokingAccount.causalPermissionAuthority,
                    defaultSessionId: invokingAccount.caller.sessionId,
                    ...(requestId ? { executeOrdinaryChildAction: async (actionId, childInput, options) => {
                        const { executeAdmittedClientActionChildAtMachine } = await import('@/sync/ops/actions/admittedClientActionChild');
                        return await executeAdmittedClientActionChildAtMachine({
                            parent: { machineId: input.machineId, requestId },
                            accountId: invokingAccount.accountId, serverId: input.serverId, sessionId: invokingAccount.caller.sessionId,
                            actionId, input: childInput,
                            ...(options?.externalActionTarget?.kind === 'machine' ? { targetMachineId: options.externalActionTarget.machineId } : {}),
                            ...(options?.signal ? { signal: options.signal } : {}),
                        });
                    } } : {}),
                } : request.defaultSessionId ? { defaultSessionId: request.defaultSessionId } : {}),
                ...(request.requiredDangerLevel ? { requiredContributedActionDangerLevel: request.requiredDangerLevel } : {}),
                ...(context?.signal ? { signal: context.signal } : {}),
            });
            const response = result.ok ? { ok: true, result: result.result ?? null } : {
                ok: false, errorCode: result.errorCode, error: result.error,
                ...(result.details !== null && typeof result.details === 'object' && Reflect.get(result.details, 'actionHandlerInvocation') === 'notStarted'
                    ? { actionHandlerInvocation: 'notStarted' } : {}),
            };
            const validated = UiContributedActionExecuteResponseV1Schema.safeParse(response);
            if (validated.success) return validated.data;
        } catch {
            // Once admitted, a lost or malformed settlement never proves the effect did not run.
        }
        return { ok: false, errorCode: PLUGIN_ACTION_OUTCOME_UNKNOWN_CODE, error: PLUGIN_ACTION_OUTCOME_UNKNOWN_CODE };
    };
}

/** Binds ordinary host Actions to the same provider-local reader and dispatcher. */
export function CurrentUiContextActionHost(): null {
    const createPort = useCurrentUiContextToolPortFactory();
    React.useLayoutEffect(() => registerCurrentUiContextActionPort(createPort), [createPort]);
    return null;
}
