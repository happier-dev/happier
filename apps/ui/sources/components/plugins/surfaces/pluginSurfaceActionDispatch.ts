import {
    PluginInvocableActionIdSchema,
    PLUGIN_ACTION_CURRENT_INTENT_REJECTED_CODE,
    PLUGIN_ACTION_OUTCOME_UNKNOWN_CODE,
    buildQualifiedPluginContributionKey,
    createPluginActionInvocation,
    createPluginActionPresentUserGate,
    pluginJsonValuesEqual,
    projectPluginActionUnavailableOutcomeCode,
    type ActionExecuteResult,
    type ActionExecutorContext,
    type ActionId,
    type ActionOperationDeclarationV1,
    type DaemonPluginStructuredMessageActionInvocationV1,
    type DaemonPluginStructuredMessageActionMountedBinding,
    type InteractionTransientRequesterV1,
    type MessageActionReferenceV1,
    PluginMachineMaterializationRefV1Schema,
    type PluginJsonValueV2,
    type PluginContributionIdentityV1,
    type PluginProjectedActionV2,
    type PluginActionCurrentIntentRequest,
    type PluginActionCurrentIntentResult,
} from '@happier-dev/protocol';
import { PluginError } from '@happier-dev/plugin-sdk';
import type { PluginReference } from '@happier-dev/plugin-sdk';
import type {
    PluginActionInvocationSurfaceV2,
    PluginClientActionHandler,
} from '@happier-dev/plugin-sdk/actions';
import type { PluginUiHostApi } from '@happier-dev/plugin-sdk/ui';
import {
    normalizePluginUiMountedContributedActionReferenceV1,
    PluginUiExecuteActionRequestV1Schema,
    PluginUiQualifiedActionReferenceV1Schema,
    pluginUiSelectedActionInputMatchesOperation,
    reconstructPluginUiSelectedActionInput,
    PluginUiSelectActionInputResultV1Schema,
} from '@happier-dev/protocol/plugins/ui';
import type {
    PluginUiHostApiErrorCodeV1,
    PluginUiHostApiRequestEnvelopeV1,
    PluginUiHostMethodV1,
    PluginUiJsonValueV1,
    CurrentUiContextSnapshotV1,
    PluginUiMountedActionReferenceV1,
    PluginUiResourceSubscriptionEventV1,
    PluginUiSelectActionInputResultV1,
    PluginUiSurfaceContextV1,
    PluginUiTargetedContributionOperationV1,
} from '@happier-dev/protocol/plugins/ui';

import { machinePluginStructuredMessageActionExecute } from '@/sync/ops/machineContributionRegistryProjection';
import {
    resolvePluginUiClientActionRegistration,
    type PluginUiClientExecutableRegistration,
} from '@/components/plugins/reactNative/clientExecutableContributions';
import { resolvePluginUiClientExecutablePlatform } from '@/sync/domains/plugins/ui/usePluginUiProjectionCurrentness';
import {
    isPluginProjectedActionExecutable,
    type PluginUiProjectionModel,
} from '@/sync/domains/plugins/ui/projection';

import { createPluginSurfaceFeedbackHandlers } from './pluginSurfaceFeedback';
import {
    createPluginSurfaceResourceReadHandler,
    type PluginSurfaceResourceBinding,
} from './pluginSurfaceResourceRead';
import {
    createPluginSurfaceResourceWatchHandlers,
    type PluginSurfaceResourceWatchTransport,
} from './pluginSurfaceResourceWatch';
import {
    createPluginSurfaceHostApiError,
    createPluginSurfaceHostApi,
    type PluginSurfaceHostApiHandlers,
    type PluginSurfaceHostApiMethodHandler,
    type PluginSurfaceHostApiRequestOptions,
    type PluginSurfaceHostApiV1,
} from './createPluginSurfaceHostApi';
import {
    createPluginSurfaceOpenSurfaceHandler,
    type PluginSurfaceOpenHandler,
} from './openPluginSurface';
import {
    createPluginSurfaceOpenableContentHandlers,
    type PluginSurfaceOpenableContentBinding,
} from './pluginSurfaceOpenableContent';
import { createPluginSurfaceLocalHostHandlers } from './pluginSurfaceLocalHostHandlers';

/** Exact producer-owned mounted binding, preserved only until RPC projection. */
export type PluginSurfaceActionMountedBinding = DaemonPluginStructuredMessageActionMountedBinding;

/** A host control may carry current Composer/Message intent, never a mount binding. */
export type PluginSurfaceHostPresentedActionInvocation = Exclude<
    DaemonPluginStructuredMessageActionInvocationV1,
    Readonly<{ kind: 'mountedPluginSurface' }>
>;

/**
 * The canonical plugin-surface action dispatcher (plan §3.5).
 *
 * One owner parses `{ action, input }` and selects exactly one branch:
 *
 *  1. **Host ActionSpec** — a bare string the master-owned `surfaces.plugin`
 *     ActionSurface key admits, validated through the canonical
 *     `PluginInvocableActionIdSchema`. It runs through the canonical
 *     ActionExecutor front door with a host-stamped `surface: 'plugin'` and
 *     `actionCaller`.
 *  2. **Contributed action** — anything else. A bare string binds to the CALLING
 *     plugin; a structured `{ pluginId, localId }` reference may name any plugin.
 *     Direct host presentation has no caller and therefore admits only that exact
 *     structured reference.
 *     Cross-plugin invocation is permitted and policed only by the target
 *     action's own declared surfaces/scopes at `evaluateTargetActionPolicy`; no
 *     caller-plugin allowlist exists here, because `ActionsService.execute`
 *     already grants plugin backend code the same reach.
 *
 * **The two stamps are different fields with different owners (UI-D26).** Branch 1
 * stamps `surface: 'plugin'` on the ActionSpec executor. Branch 2 stamps
 * `executionSurface` from this dispatcher's `invocationSurface` on the
 * contributed-action front door (`ui` by default, or `voice` from the Voice
 * bridge). That stamp is an INVARIANT of this dispatcher — it is deliberately
 * absent from every caller binding, so no mount or transport can omit or
 * downgrade it.
 *
 * A failed dispatch is ALWAYS a typed failure. `ok: false` is never returned as a
 * successful action result (UI-D08).
 */

export type PluginSurfaceHostActionExecute = (
    actionId: ActionId,
    input: unknown,
    context?: ActionExecutorContext,
) => Promise<ActionExecuteResult>;

/** Branch 1 wiring: the canonical ActionExecutor plus the host front-door context. */
export type PluginSurfaceHostActionBinding = Readonly<{
    execute: PluginSurfaceHostActionExecute;
    context?: ActionExecutorContext;
}>;

export type PluginSurfaceContributedActionTransport =
    typeof machinePluginStructuredMessageActionExecute;

/**
 * Exact lookup over the daemon-admitted V2 Action projection for the current
 * UI owner. The resolver carries raw projection facts only; it cannot invent a
 * target, registration, or daemon binding.
 */
export type PluginSurfaceContributedActionDescriptorResolver = (
    identity: PluginContributionIdentityV1,
) => PluginProjectedActionV2 | null;

/**
 * Branch 2 wiring. Note the absence of `executionSurface`: the stamp belongs to
 * the dispatcher, so a caller can neither omit nor downgrade it (UI-D26).
 */
export type PluginSurfaceContributedActionBinding = Readonly<{
    machineId: string;
    serverId?: string | null;
    expectedGeneration: string;
    /**
     * Exact resolved Action-plugin generation for a catalog-owned caller such
     * as Automation Event setup. It uses the canonical daemon Action fence;
     * no caller provenance or second dispatcher is manufactured here.
     */
    expectedImmutableGenerationId?: string;
    sessionId?: string;
    /** Opaque server-issued message identity, resolved by the daemon before dispatch. */
    messageActionReference?: MessageActionReferenceV1;
    timeoutMs?: number;
    execute?: PluginSurfaceContributedActionTransport;
}>;

/** UI dispatch can originate from an interactive surface or the Voice bridge. */
export type PluginSurfaceActionInvocationSurface = Extract<
    PluginActionInvocationSurfaceV2,
    'ui' | 'voice'
>;

/**
 * Exact non-daemon facts for one client-targeted Action invocation. The generic
 * executable composition remains the registration/index owner; this binding
 * provides only the caller's current projection and incumbent UI capabilities.
 */
export type PluginSurfaceClientActionBinding = Readonly<{
    projectionGeneration: number;
    sessionId?: string;
    openSurface?: PluginSurfaceOpenHandler;
    requestCurrentIntent?: (
        request: PluginActionCurrentIntentRequest<PluginProjectedActionV2>,
    ) => Promise<PluginActionCurrentIntentResult>;
    currentUiContext?: () => CurrentUiContextSnapshotV1 | null | undefined;
}>;

export type PluginSurfaceActionDispatchOutcome =
    | Readonly<{ ok: true; result: PluginUiJsonValueV1 }>
    | Readonly<{ ok: false; code: PluginUiHostApiErrorCodeV1; reason: string }>;

export type DispatchPluginSurfaceActionInput = Readonly<{
    /** Stable host request identity used only by the daemon's operation observer. */
    actionRequestId?: string;
    /**
     * The one admission moment for host-side Action-operation presentation.
     *
     * Invoked at most once, synchronously, after every local refusal gate and
     * immediately before the daemon transport, with the exact admitted
     * operation declaration. A caller that presents an operation registers
     * here rather than guessing from its own projection read, so a refused
     * launch leaves nothing behind and a synchronous operation snapshot cannot
     * arrive before its presentation custody exists.
     */
    onDaemonActionOperationAdmitted?: (operation: ActionOperationDeclarationV1) => void;
    /**
     * The mounted plugin owning the request (host-stamped, never author-supplied).
     * Direct host presentation deliberately has no plugin caller.
     */
    callerPluginId?: string;
    /** The declaring surface contribution, stamped from the mounted context. */
    callerContributionLocalId?: string;
    /**
     * Exact producer-owned mounted binding for a plugin invocation. Absent is
     * a deliberate host-presentation origin, but a declared caller contribution
     * without this binding fails closed.
    */
    callerBinding?: PluginSurfaceActionMountedBinding;
    action: PluginUiMountedActionReferenceV1;
    input?: PluginUiJsonValueV1;
    hostAction?: PluginSurfaceHostActionBinding;
    contributedAction?: PluginSurfaceContributedActionBinding;
    /** Exact client-side projection/lifecycle binding; never a daemon fallback. */
    clientAction?: PluginSurfaceClientActionBinding;
    /** UI is the default; Voice supplies its own canonical invoking surface. */
    invocationSurface?: PluginSurfaceActionInvocationSurface;
    /**
     * The current raw V2 Action projection. Target selection belongs to this
     * producer-owned descriptor, never to a daemon binding or caller-local
     * availability predicate.
     */
    resolveContributedAction?: PluginSurfaceContributedActionDescriptorResolver;
    /**
     * Exact present-user host intent. Mounted provenance is derived here from
     * the bound controller's private caller binding; a host control cannot
     * publish or manufacture that third union arm.
     */
    invocation?: PluginSurfaceHostPresentedActionInvocation;
    /** Live daemon capability owned by the bound controller, never a new action owner. */
    isContributedActionAvailable?: () => boolean;
    signal?: AbortSignal;
    isCurrent?: () => boolean;
    /** Exact target-scoped admission handle retained host-private after form selection. */
    targetedOperation?: PluginUiTargetedContributionOperationV1;
    /** Complete host-selected settlement paired with `targetedOperation`. */
    selectedActionInput?: Extract<
        PluginUiSelectActionInputResultV1,
        Readonly<{ kind: 'submitted' }>
    >;
}>;

type PluginSurfaceActionDispatchFailure = Extract<
    PluginSurfaceActionDispatchOutcome,
    Readonly<{ ok: false }>
>;

function failure(
    code: PluginUiHostApiErrorCodeV1,
    reason: string,
): PluginSurfaceActionDispatchFailure {
    return { ok: false, code, reason };
}

function readString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

type MountedPluginActionCaller = Readonly<{
    pluginId: string;
    contributionLocalId: string;
    materialization: ReturnType<typeof PluginMachineMaterializationRefV1Schema.parse>;
    mountedBinding: PluginSurfaceActionMountedBinding;
}>;

/**
 * One UI-side gate for every plugin Action edge. The binding is producer-owned
 * mount metadata, not raw caller JSON; the daemon independently revalidates it
 * before deriving invocation authority.
 */
function resolveMountedPluginActionCaller(
    input: DispatchPluginSurfaceActionInput,
): MountedPluginActionCaller | null {
    const pluginId = readString(input.callerPluginId);
    const contributionLocalId = readString(input.callerContributionLocalId);
    const mountedBinding = input.callerBinding;
    if (!pluginId || !contributionLocalId || !mountedBinding) return null;
    const materialization = PluginMachineMaterializationRefV1Schema.safeParse(
        mountedBinding.materializationRef,
    );
    if (
        !materialization.success
        || mountedBinding.contributionLocalId !== contributionLocalId
        || materialization.data.pluginId !== pluginId
        || (
            input.contributedAction !== undefined
            && materialization.data.machineId !== input.contributedAction.machineId
        )
    ) {
        return null;
    }
    return Object.freeze({
        pluginId,
        contributionLocalId,
        materialization: materialization.data,
        mountedBinding,
    });
}

/** The only currentness/cancellation decision in the plugin-surface action path. */
function preflightFailure(
    input: DispatchPluginSurfaceActionInput,
): PluginSurfaceActionDispatchOutcome | null {
    if (input.signal?.aborted) return failure('unavailable', 'plugin_ui_invocation_aborted');
    if (input.isCurrent && !input.isCurrent()) {
        return failure('stale_surface', 'plugin_ui_generation_retired');
    }
    return null;
}

function resolveContributedActionIdentity(input: DispatchPluginSurfaceActionInput) {
    if (input.callerPluginId !== undefined) {
        return normalizePluginUiMountedContributedActionReferenceV1({
            callerPluginId: input.callerPluginId,
            action: input.action,
        });
    }

    // The mounted-action normalizer rightly requires a caller for a bare local
    // id. A catalog/whole-message host presents only an exact target identity
    // and has no plugin caller to authenticate or manufacture.
    const directHostReference = PluginUiQualifiedActionReferenceV1Schema.safeParse(input.action);
    return directHostReference.success ? directHostReference.data : null;
}

/**
 * A caller receives the exact raw V2 descriptor only through the current
 * projection resolver. Re-checking its identity here prevents an accidental
 * stale or cross-key lookup from selecting a different target at dispatch.
 */
function resolveProjectedContributedAction(
    input: DispatchPluginSurfaceActionInput,
    identity: PluginContributionIdentityV1,
): PluginProjectedActionV2 | null {
    try {
        const action = input.resolveContributedAction?.(identity) ?? null;
        return isPluginProjectedActionExecutable(action)
            && action.pluginId === identity.pluginId
            && action.id === identity.localId
            ? action
            : null;
    } catch {
        return null;
    }
}

type ClientContributedActionSelection = Readonly<{
    action: PluginProjectedActionV2;
    binding: PluginSurfaceClientActionBinding;
    registration: PluginUiClientExecutableRegistration;
    /** Opaque generic-registration value, narrowed at the public SDK boundary. */
    handler: PluginClientActionHandler;
    pluginVersion: string;
    isCurrent: () => boolean;
}>;

/**
 * Reads one Action from the producer-owned generic executable index. The raw
 * descriptor, exact target/origin and registration generation must all remain
 * current together; no client registration can be reconstructed or substituted
 * by a caller-local availability predicate.
 */
function resolveClientContributedActionSelection(
    input: DispatchPluginSurfaceActionInput,
    identity: PluginContributionIdentityV1,
    expectedAction: PluginProjectedActionV2,
): ClientContributedActionSelection | null {
    const binding = input.clientAction;
    if (
        !binding
        || !Number.isInteger(binding.projectionGeneration)
        || binding.projectionGeneration < 0
    ) {
        return null;
    }
    const action = resolveProjectedContributedAction(input, identity);
    if (
        action !== expectedAction
        || action.execution.target !== 'client'
        || !action.authorization
    ) {
        return null;
    }
    const platform = resolvePluginUiClientExecutablePlatform();
    const resolvedRegistration = resolvePluginUiClientActionRegistration({
        action,
        projectionGeneration: binding.projectionGeneration,
        platform,
    });
    if (!resolvedRegistration) return null;
    const { registration, handler, pluginVersion } = resolvedRegistration;
    const isCurrent = (): boolean => {
        if (input.isCurrent?.() === false) return false;
        if (!registration.lifecycle.isCurrent() || registration.lifecycle.signal.aborted) return false;
        if (resolveProjectedContributedAction(input, identity) !== expectedAction) return false;
        return resolvePluginUiClientActionRegistration({
            action: expectedAction,
            projectionGeneration: binding.projectionGeneration,
            platform,
        })?.registration === registration;
    };
    return isCurrent()
        ? Object.freeze({ action, binding, registration, handler, pluginVersion, isCurrent })
        : null;
}

function clientActionOpenSurface(
    selection: ClientContributedActionSelection,
): PluginUiHostApi['openSurface'] {
    return async (view: PluginReference, actionInput, options): Promise<void> => {
        if (!selection.isCurrent()) {
            throw new PluginError({ code: 'plugin_action_generation_retired' });
        }
        if (options?.signal?.aborted) {
            throw new PluginError({ code: 'plugin_action_aborted' });
        }
        const openSurface = selection.binding.openSurface;
        if (!openSurface) {
            throw new PluginError({ code: 'plugin_surface_open_unavailable' });
        }
        // This is the SDK's public bare-reference qualification rule. It only
        // adapts the Action capability to the existing incumbent navigation
        // owner; it does not resolve a route or create a second surface owner.
        const destination = typeof view === 'string'
            ? { pluginId: selection.action.pluginId, localId: view }
            : { pluginId: view.pluginId, localId: view.localId };
        const outcome = await openSurface({
            destination,
            ...(actionInput === undefined ? {} : { input: actionInput }),
            ...(options?.subPath === undefined ? {} : { subPath: options.subPath }),
            ...(options?.instanceKey === undefined ? {} : { instanceKey: options.instanceKey }),
        });
        if (!outcome.ok) {
            throw new PluginError({ code: outcome.reason });
        }
    };
}

function readClientActionCurrentUiContext(
    selection: ClientContributedActionSelection,
): CurrentUiContextSnapshotV1 | undefined {
    try {
        return selection.binding.currentUiContext?.() ?? undefined;
    } catch {
        return undefined;
    }
}

function clientActionFailure(
    code: string,
): PluginSurfaceActionDispatchOutcome {
    return actionDeclinedFailure(code) ?? failure(
        code === 'plugin_action_generation_retired' ? 'stale_surface' : 'unavailable',
        code,
    );
}

/**
 * Projects a present-user DECLINE onto the typed `denied` host code.
 *
 * A decline is a decision, not an absence. Settling it as `unavailable` makes a
 * deliberate "no" indistinguishable from "this Action is not available right
 * now", which invites an autonomous caller (Voice) to ask the same person
 * again. The rejection code is minted by the canonical current-intent gate, so
 * both the client-target and daemon-target settlements recognise it here.
 */
function actionDeclinedFailure(
    code: string,
): PluginSurfaceActionDispatchOutcome | null {
    return code === PLUGIN_ACTION_CURRENT_INTENT_REJECTED_CODE
        ? failure('denied', code)
        : null;
}

/** Maps the canonical indeterminate Action code to Voice's private terminal fact. */
function actionOutcomeUnknownFailure(
    code: string,
): PluginSurfaceActionDispatchOutcome | null {
    return code === PLUGIN_ACTION_OUTCOME_UNKNOWN_CODE
        ? failure('timeout', 'plugin_ui_action_outcome_unknown')
        : null;
}

async function executeClientContributedAction(
    input: DispatchPluginSurfaceActionInput,
    identity: PluginContributionIdentityV1,
    projectedAction: PluginProjectedActionV2,
    /** The dispatcher-settled input, already carrying any selected Account ref. */
    settledInput: PluginUiJsonValueV1 | undefined,
): Promise<PluginSurfaceActionDispatchOutcome> {
    const initial = resolveClientContributedActionSelection(input, identity, projectedAction);
    if (!initial) return failure('unavailable', 'plugin_surface_client_action_unavailable');
    const invocationSurface = input.invocationSurface ?? 'ui';
    const invocation = createPluginActionInvocation({
        pluginId: identity.pluginId,
        localId: identity.localId,
        ...(projectedAction.inputSchema === undefined
            ? {}
            : { inputSchema: projectedAction.inputSchema }),
        ...(projectedAction.outputSchema === undefined
            ? {}
            : { resultSchema: projectedAction.outputSchema }),
        generationSignal: initial.registration.lifecycle.signal,
        isCurrent: initial.isCurrent,
    });
    const presentUserGate = createPluginActionPresentUserGate<PluginProjectedActionV2>({
        resolve: () => {
            const current = resolveClientContributedActionSelection(input, identity, projectedAction);
            if (!current || !current.action.authorization) {
                return Object.freeze({
                    status: 'unavailable' as const,
                    code: 'plugin_surface_client_action_unavailable',
                });
            }
            return Object.freeze({
                status: 'resolved' as const,
                action: current.action,
                policy: Object.freeze({
                    qualifiedId: invocation.qualifiedId,
                    generation: String(current.binding.projectionGeneration),
                    dangerLevel: current.action.dangerLevel,
                    scopes: current.action.scopes,
                    surfaces: current.action.surfaces,
                    ...(current.action.confirmation === undefined
                        ? {}
                        : { confirmation: current.action.confirmation }),
                    authorization: current.action.authorization,
                    fingerprintContext: Object.freeze({
                        target: current.registration.target,
                        executionOrigin: current.registration.executionOrigin,
                        projectionGeneration: current.registration.projectionGeneration,
                        packageVersion: current.pluginVersion,
                    }),
                }),
                isCurrent: current.isCurrent,
            });
        },
        ...(initial.binding.requestCurrentIntent
            ? { requestCurrentIntent: initial.binding.requestCurrentIntent }
            : {}),
    });
    const result = await invocation.invoke(settledInput ?? null, {
        ...(input.signal ? { signal: input.signal } : {}),
        preDispatch: async (handlerInput) => {
            const admission = await presentUserGate.admit({
                input: handlerInput.input,
                surface: invocationSurface,
                invocationSurface,
                ...(initial.binding.sessionId === undefined
                    ? {}
                    : { sessionId: initial.binding.sessionId }),
                signal: handlerInput.signal,
            });
            switch (admission.status) {
                case 'admitted':
                    break;
                case 'deferred':
                    // Deferred approval is an API-only settlement. UI and Voice
                    // have no deferred response envelope, so keep it as the
                    // gate's canonical no-effect refusal instead of starting
                    // the handler without a present-user decision.
                    return Object.freeze({
                        status: 'unavailable' as const,
                        code: 'plugin_action_current_intent_unavailable',
                        message: 'plugin_action_current_intent_unavailable',
                    });
                case 'unavailable':
                case 'failed':
                    return Object.freeze({
                        status: 'unavailable' as const,
                        code: admission.code,
                        message: admission.message,
                    });
            }
            // Approval is followed by the shared gate's fresh policy pass; this
            // final exact registration read closes the interval before effects.
            return resolveClientContributedActionSelection(input, identity, projectedAction)
                ? null
                : Object.freeze({
                    status: 'unavailable' as const,
                    code: 'plugin_action_generation_retired',
                    message: 'Plugin action generation is no longer current',
                });
        },
        handler: ({ input: actionInput, signal }) => {
            const current = resolveClientContributedActionSelection(input, identity, projectedAction);
            if (!current) {
                throw new PluginError({ code: 'plugin_action_generation_retired' });
            }
            const currentUiContext = readClientActionCurrentUiContext(current);
            return current.handler(actionInput, {
                plugin: {
                    id: current.action.pluginId,
                    version: current.pluginVersion,
                },
                contribution: {
                    id: current.action.id,
                    qualifiedId: invocation.qualifiedId,
                },
                invocationSurface,
                signal,
                ui: { openSurface: clientActionOpenSurface(current) },
                ...(currentUiContext === undefined ? {} : { currentUiContext }),
            });
        },
    });
    if (result.status === 'executed') {
        return { ok: true, result: result.value as PluginUiJsonValueV1 };
    }
    if (result.status === 'invalid') {
        return clientActionFailure(result.code);
    }
    if (result.status === 'unavailable') {
        const code = projectPluginActionUnavailableOutcomeCode(
            result.code,
            result.actionHandlerInvocation,
        );
        return actionOutcomeUnknownFailure(code) ?? clientActionFailure(code);
    }
    return clientActionFailure(result.code);
}

type SubmittedSelectedActionInput = Extract<
    PluginUiSelectActionInputResultV1,
    Readonly<{ kind: 'submitted' }>
>;

/**
 * The settled selected-operation facts for one dispatch.
 *
 * `direct` is present when the dispatched Action is the selected operation's
 * own Action; `relay` is present when the mounted target instead invokes one of
 * its own management Actions and the carrier must travel beside the input.
 */
type SettledSelectedTargetedOperation = Readonly<{
    direct: PluginUiTargetedContributionOperationV1 | undefined;
    input: PluginUiJsonValueV1 | undefined;
    relay: Readonly<{
        operation: PluginUiTargetedContributionOperationV1;
        result: SubmittedSelectedActionInput;
    }> | undefined;
}>;

type SelectedTargetedOperationSettlement =
    | (Readonly<{ ok: true }> & SettledSelectedTargetedOperation)
    | PluginSurfaceActionDispatchFailure;

/**
 * Settle the host-selected operation once, before execution placement is known.
 *
 * Mounted-target ownership, direct-versus-relay authorization, the exact
 * selected-input comparison, and Connected-Account reconstruction are semantics
 * of the selection itself, not of a transport. A client-executed Action carries
 * the same selection power as a daemon-executed one (C1), so this settlement is
 * shared and the only combination a client placement cannot serve — a relay,
 * whose carrier has no client-side channel — is refused explicitly here rather
 * than silently losing the caller's selection.
 */
function settleSelectedTargetedOperation(
    input: DispatchPluginSurfaceActionInput,
    identity: PluginContributionIdentityV1,
    caller: MountedPluginActionCaller | null,
): SelectedTargetedOperationSettlement {
    const directTargetedOperation = input.targetedOperation
        && matchesTargetedOperationAction(input.action, input.targetedOperation)
        ? input.targetedOperation
        : undefined;
    if (!input.targetedOperation || !input.selectedActionInput) {
        return { ok: true, direct: directTargetedOperation, input: input.input, relay: undefined };
    }
    if (
        !caller
        || input.selectedActionInput.selection.target.pluginId !== caller.pluginId
        || (!directTargetedOperation && identity.pluginId !== caller.pluginId)
    ) {
        // A selected settlement is anchored to the exact mounted target. Its
        // own admitted Action may run directly, but a relay may only invoke a
        // management Action owned by that same target; another contributor
        // cannot borrow the carrier.
        return failure('invalid_payload', 'plugin_surface_targeted_selection_invalid');
    }
    if (!directTargetedOperation) {
        return {
            ok: true,
            direct: undefined,
            input: input.input,
            relay: {
                operation: input.targetedOperation,
                result: input.selectedActionInput,
            },
        };
    }
    if (
        input.input === undefined
        || !pluginJsonValuesEqual(input.input, input.selectedActionInput.input)
    ) {
        return failure('invalid_payload', 'plugin_surface_targeted_selection_invalid');
    }
    const reconstructed = reconstructPluginUiSelectedActionInput(input.selectedActionInput);
    if (!reconstructed) {
        return failure('invalid_payload', 'plugin_surface_targeted_selection_input_invalid');
    }
    return {
        ok: true,
        direct: directTargetedOperation,
        input: reconstructed,
        relay: undefined,
    };
}

function matchesTargetedOperationAction(
    action: PluginUiMountedActionReferenceV1,
    operation: PluginUiTargetedContributionOperationV1,
): boolean {
    return typeof action !== 'string'
        && action.pluginId === operation.action.pluginId
        && action.localId === operation.action.localId;
}

export async function dispatchPluginSurfaceAction(
    input: DispatchPluginSurfaceActionInput,
): Promise<PluginSurfaceActionDispatchOutcome> {
    const preflight = preflightFailure(input);
    if (preflight) return preflight;

    if ((input.targetedOperation === undefined) !== (input.selectedActionInput === undefined)) {
        return failure('invalid_payload', 'plugin_surface_targeted_selection_invalid');
    }
    if (
        input.targetedOperation
        && input.selectedActionInput
        && !pluginUiSelectedActionInputMatchesOperation(
            input.selectedActionInput,
            input.targetedOperation,
        )
    ) {
        return failure('invalid_payload', 'plugin_surface_targeted_selection_invalid');
    }

    // The master-owned `surfaces.plugin` ActionSurface key is the single
    // membership authority for branch 1. It is parsed through the canonical
    // schema rather than restated as a UI-local allowlist.
    const hostActionId = typeof input.action === 'string'
        ? PluginInvocableActionIdSchema.safeParse(input.action)
        : null;
    if (hostActionId?.success) {
        if (input.targetedOperation || input.selectedActionInput) {
            return failure('invalid_payload', 'plugin_surface_targeted_operation_action_mismatch');
        }
        return executeHostAction(input, hostActionId.data as ActionId);
    }
    return executeContributedAction(input);
}

async function executeHostAction(
    input: DispatchPluginSurfaceActionInput,
    actionId: ActionId,
): Promise<PluginSurfaceActionDispatchOutcome> {
    const binding = input.hostAction;
    if (!binding) return failure('unavailable', 'plugin_surface_host_action_unavailable');
    const callerPluginId = readString(input.callerPluginId);
    if (!callerPluginId) {
        return failure('invalid_payload', 'plugin_surface_host_action_caller_missing');
    }
    const hasMountedContribution = Boolean(readString(input.callerContributionLocalId));
    const caller = hasMountedContribution
        ? resolveMountedPluginActionCaller(input)
        : null;
    if (hasMountedContribution && !caller) {
        return failure('unavailable', 'plugin_mounted_caller_unavailable');
    }

    const result = await binding.execute(actionId, input.input, {
        ...binding.context,
        ...(input.signal ? { signal: input.signal } : {}),
        surface: 'plugin',
        ...(caller
            ? {
                actionCaller: {
                    kind: 'plugin' as const,
                    pluginId: caller.pluginId,
                    contributionLocalId: caller.contributionLocalId,
                    materialization: caller.materialization,
                },
            }
            : {}),
    });
    if (result.ok) return { ok: true, result: result.result as PluginUiJsonValueV1 };
    return failure('unavailable', result.errorCode);
}

async function executeContributedAction(
    input: DispatchPluginSurfaceActionInput,
): Promise<PluginSurfaceActionDispatchOutcome> {
    const identity = resolveContributedActionIdentity(input);
    if (!identity) return failure('invalid_payload', 'plugin_surface_action_reference_invalid');
    const hasMountedContribution = Boolean(readString(input.callerContributionLocalId));
    const caller = hasMountedContribution
        ? resolveMountedPluginActionCaller(input)
        : null;
    if (hasMountedContribution && !caller) {
        return failure('unavailable', 'plugin_mounted_caller_unavailable');
    }
    if (caller && input.invocation) {
        return failure('invalid_payload', 'plugin_surface_action_invocation_ambiguous');
    }

    const projectedAction = resolveProjectedContributedAction(input, identity);
    if (!projectedAction) {
        return failure('unavailable', 'plugin_surface_action_projection_unavailable');
    }
    // Execution placement is chosen after the selected-operation carrier is
    // settled, so a client Action cannot bypass ownership, comparison, or
    // Connected-Account reconstruction that a daemon Action must satisfy.
    const settlement = settleSelectedTargetedOperation(input, identity, caller);
    if (!settlement.ok) return settlement;
    if (projectedAction.execution.target === 'client') {
        if (settlement.relay) {
            // The relay carrier is a daemon-request field. A client placement
            // has no channel for it, so the combination is refused at this one
            // owner instead of executing with the selection silently dropped.
            return failure('unsupported_method', 'plugin_surface_targeted_selection_relay_unsupported');
        }
        return executeClientContributedAction(input, identity, projectedAction, settlement.input);
    }

    if (input.isContributedActionAvailable?.() === false) {
        return failure('unavailable', 'plugin_surface_contributed_action_unavailable');
    }
    const binding = input.contributedAction;
    if (!binding) return failure('unavailable', 'plugin_surface_contributed_action_unavailable');
    if (caller && caller.materialization.machineId !== binding.machineId) {
        return failure('unavailable', 'plugin_mounted_caller_unavailable');
    }

    const execute = binding.execute ?? machinePluginStructuredMessageActionExecute;
    // The admitted projection owns whether this invocation can produce a daemon
    // operation at all; a declaration-free Action still carries no request id.
    const admittedOperation = projectedAction.operation;
    const admittedRequestId = admittedOperation ? input.actionRequestId : undefined;
    if (admittedOperation && admittedRequestId) {
        input.onDaemonActionOperationAdmitted?.(admittedOperation);
    }
    const actionInput = settlement.input;
    const expectedImmutableGenerationId = settlement.direct
        ? settlement.direct.contributor.immutableGenerationId
        : binding.expectedImmutableGenerationId;
    const result = await execute(binding.machineId, {
        serverId: binding.serverId ?? null,
        expectedGeneration: binding.expectedGeneration,
        qualifiedActionId: buildQualifiedPluginContributionKey(identity),
        ...(admittedRequestId ? { requestId: admittedRequestId } : {}),
        ...(actionInput === undefined
            ? {}
            : {
                // The SDK makes JSON containers readonly for authors while
                // Protocol's equivalent recursive JSON type is mutable. The
                // RPC owner immediately schema-parses this same value.
                input: actionInput as PluginJsonValueV2,
            }),
        // UI-D26: the dispatcher owns this stamp; no caller can omit it.
        executionSurface: input.invocationSurface ?? 'ui',
        // A mounted host supplies the exact producer binding at this one
        // canonical projection point. Host-presented Composer/Message controls
        // instead forward their typed current intent; neither can impersonate
        // the other provenance arm.
        ...(caller
            ? {
                invocation: {
                    kind: 'mountedPluginSurface' as const,
                    mountedBinding: caller.mountedBinding,
                },
            }
            : input.invocation ? { invocation: input.invocation } : {}),
        ...(binding.sessionId ? { sessionId: binding.sessionId } : {}),
        ...(binding.messageActionReference
            ? { messageActionReference: binding.messageActionReference }
            : {}),
        ...(binding.timeoutMs === undefined ? {} : { timeoutMs: binding.timeoutMs }),
        ...(expectedImmutableGenerationId
            ? { expectedContributorImmutableGenerationId: expectedImmutableGenerationId }
            : {}),
        ...(settlement.relay
            ? { selectedActionInputCarrier: settlement.relay }
            : {}),
        ...(input.signal ? { signal: input.signal } : {}),
    });

    if (!result.supported) {
        if (result.reason === 'outcomeUnknown') {
            // The exact daemon Action was emitted, but its settlement did not
            // arrive. Keep the host API's bounded timeout code while carrying
            // the private indeterminate-effect fact to Voice custody.
            return failure('timeout', 'plugin_ui_action_outcome_unknown');
        }
        return failure('unavailable', 'plugin_ui_action_host_unavailable');
    }
    if (result.result.ok) {
        // The daemon response is the canonical action settlement. Once it reports
        // success, a later local abort or generation observation must not hide an
        // outward result already known — that would invite a blind mutation retry.
        return { ok: true, result: result.result.result as PluginUiJsonValueV1 };
    }
    const outcomeUnknown = actionOutcomeUnknownFailure(result.result.code);
    if (outcomeUnknown) return outcomeUnknown;
    return actionDeclinedFailure(result.result.code)
        ?? failure('unavailable', result.result.code);
}

export type CreatePluginSurfaceActionDispatchHandlerInput = Readonly<{
    pluginId: string;
    /** Exact declaring contribution from the bound mount's validated context. */
    contributionId?: string;
    callerBinding?: PluginSurfaceActionMountedBinding;
    hostAction?: PluginSurfaceHostActionBinding;
    contributedAction?: PluginSurfaceContributedActionBinding;
    clientAction?: PluginSurfaceClientActionBinding;
    invocationSurface?: PluginSurfaceActionInvocationSurface;
    resolveContributedAction?: PluginSurfaceContributedActionDescriptorResolver;
    isContributedActionAvailable?: () => boolean;
    isCurrent?: () => boolean;
}>;

/**
 * The mounted `executeAction` handler parses the Protocol-owned raw request
 * grammar and defers every identity, policy and settlement decision to
 * {@link dispatchPluginSurfaceAction}.
 *
 * There is no `actionId` alias: `packages/protocol/src/plugins/**` does not exist
 * in any released tag, nor in the `remote-dev` predecessor, so no reachable
 * client can send the predecessor spelling (§4 atomic direct cutover).
 */
export function createPluginSurfaceActionDispatchHandler(
    input: CreatePluginSurfaceActionDispatchHandlerInput,
): PluginSurfaceHostApiMethodHandler {
    return async (
        request: PluginUiHostApiRequestEnvelopeV1,
        options?: PluginSurfaceHostApiRequestOptions,
    ): Promise<PluginUiJsonValueV1> => {
        const payload = PluginUiExecuteActionRequestV1Schema.safeParse(request.payload);
        if (!payload.success) {
            return createPluginSurfaceHostApiError(
                'invalid_payload',
                ['plugin_surface_action_payload_invalid'],
            );
        }
        const callerContributionLocalId = readString(input.contributionId);
        const targetedOperation = options?.targetedOperation;
        let selectedActionInput: Extract<
            PluginUiSelectActionInputResultV1,
            Readonly<{ kind: 'submitted' }>
        > | undefined;
        if (targetedOperation || options?.selectedActionInput !== undefined) {
            const selected = PluginUiSelectActionInputResultV1Schema.safeParse(
                options.selectedActionInput,
            );
            if (
                !targetedOperation
                || !selected.success
                || selected.data.kind !== 'submitted'
                || selected.data.selection.target.pluginId !== input.pluginId
                || !pluginUiSelectedActionInputMatchesOperation(selected.data, targetedOperation)
            ) {
                return createPluginSurfaceHostApiError(
                    'invalid_payload',
                    ['plugin_surface_targeted_selection_invalid'],
                );
            }
            selectedActionInput = selected.data;
        }

        const outcome = await dispatchPluginSurfaceAction({
            callerPluginId: input.pluginId,
            ...(callerContributionLocalId
                ? { callerContributionLocalId }
                : {}),
            ...(input.callerBinding ? { callerBinding: input.callerBinding } : {}),
            action: payload.data.action,
            // The public action input permits an omitted value for declarative
            // commands, while explicit JSON `null` is an author value. Keep
            // the property absent at the dispatch boundary in the former case.
            ...(payload.data.input === undefined ? {} : { input: payload.data.input }),
            ...(input.hostAction ? { hostAction: input.hostAction } : {}),
            ...(input.contributedAction ? { contributedAction: input.contributedAction } : {}),
            ...(input.clientAction ? { clientAction: input.clientAction } : {}),
            ...(input.invocationSurface ? { invocationSurface: input.invocationSurface } : {}),
            ...(input.resolveContributedAction
                ? { resolveContributedAction: input.resolveContributedAction }
                : {}),
            ...(input.isContributedActionAvailable
                ? { isContributedActionAvailable: input.isContributedActionAvailable }
                : {}),
            ...(options?.signal ? { signal: options.signal } : {}),
            ...(targetedOperation ? { targetedOperation } : {}),
            ...(selectedActionInput ? { selectedActionInput } : {}),
            ...(input.isCurrent ? { isCurrent: input.isCurrent } : {}),
        });
        return outcome.ok
            ? outcome.result
            : createPluginSurfaceHostApiError(outcome.code, [outcome.reason]);
    };
}

/**
 * Compose the canonical surface Host API for an interactive mount: action
 * dispatch plus the feedback and confirmation handlers, which delegate to
 * Happier's own presentation and interaction owners (§3.4). Every other method
 * keeps the shared factory's fail-closed default.
 *
 * `openSurface` is installed only when the placement supplies a destination
 * selector (EU-5a). A placement that cannot select a destination advertises no
 * `openSurface`, so the method fails with a typed `unsupported_method` instead
 * of resolving after doing nothing — the installed set stays factual (UI-D02).
 */
export function createPluginSurfaceActionHostApi(input: Readonly<{
    surfaceContext: PluginUiSurfaceContextV1;
    hostAction?: PluginSurfaceHostActionBinding;
    contributedAction?: PluginSurfaceContributedActionBinding;
    /** Exact client projection facts, extended only with incumbent UI capabilities below. */
    clientAction?: PluginSurfaceClientActionBinding;
    invocationSurface?: PluginSurfaceActionInvocationSurface;
    resolveContributedAction?: PluginSurfaceContributedActionDescriptorResolver;
    callerBinding?: PluginSurfaceActionMountedBinding;
    openSurface?: PluginSurfaceOpenHandler;
    /** Target-scoped input selection producer; never an Action executor. */
    selectActionInput?: PluginSurfaceHostApiMethodHandler;
    /**
     * The daemon binding for the resource snapshot authority (§3.6). Present
     * only when the mount can address a machine and a projected generation, so
     * `readResource` is installed — and therefore advertised — exactly where it
     * can actually be served.
     */
    resource?: PluginSurfaceResourceBinding;
    /** The bound controller's mount lifetime for daemon-backed Resource work. */
    resourceLifetimeSignal?: AbortSignal;
    /**
     * EU-4b: the mount's sink for live resource invalidations. `watchResource`
     * is installed — and therefore advertised — only when the mount can both
     * address the daemon AND deliver an event back into the surface, so a mount
     * that cannot deliver never advertises a subscription it could not serve.
     */
    resourceInvalidation?: Readonly<{
        deliver: (event: PluginUiResourceSubscriptionEventV1) => void;
        transport?: Partial<PluginSurfaceResourceWatchTransport>;
    }>;
    /** Exact selected workspace-file viewer binding; absent means no file custody. */
    openableContent?: PluginSurfaceOpenableContentBinding;
    /** Exact mounted provenance for app-scope transient presentation. */
    interactionRequester?: InteractionTransientRequesterV1;
    /**
     * The mount's admitted UI projection. Presentation-only: it resolves the
     * author's declared Action-confirmation wording for the current locale.
     */
    pluginUiProjection?: PluginUiProjectionModel | null;
    /** Live controller capability for daemon-owned host methods. */
    isMethodAvailable?: (method: PluginUiHostMethodV1) => boolean;
    /** Live controller capability for the daemon branch of `executeAction`. */
    isContributedActionAvailable?: () => boolean;
    /**
     * Exact host-owned semantics for this physical mount. These supplement the
     * canonical facade; they never replace Action, Resource, or local handlers.
     */
    mountedHostApiHandlers?: PluginSurfaceHostApiHandlers;
    /** Retires effects owned by `mountedHostApiHandlers` with this same mount. */
    disposeMountedHostApiHandlers?: () => void;
    isCurrent?: () => boolean;
}>): PluginSurfaceHostApiV1 {
    // Workspace-file viewers are a distinct semantic role. The concrete
    // openable binding is its authority, so install exactly its context/stat/read
    // handlers instead of carrying a second static method list through the UI.
    // This branch intentionally constructs none of the generic local, Action,
    // feedback, Resource, navigation, or selection handlers.
    if (input.openableContent) {
        return createPluginSurfaceHostApi({
            surfaceContext: input.surfaceContext,
            ...(input.isMethodAvailable ? { isMethodAvailable: input.isMethodAvailable } : {}),
            ...(input.isCurrent ? { isCurrent: input.isCurrent } : {}),
            handlers: {
                ...createPluginSurfaceOpenableContentHandlers({
                    binding: input.openableContent,
                    ...(input.isCurrent ? { isCurrent: input.isCurrent } : {}),
                }),
            },
            ...(input.disposeMountedHostApiHandlers
                ? { onDispose: input.disposeMountedHostApiHandlers }
                : {}),
        });
    }
    const feedback = createPluginSurfaceFeedbackHandlers({
        pluginUiProjection: input.pluginUiProjection,
        surfaceId: input.surfaceContext.surfaceId,
        ...(input.interactionRequester ? { interactionRequester: input.interactionRequester } : {}),
        ...(input.isCurrent ? { isCurrent: input.isCurrent } : {}),
    });
    const resourceWatch = input.resource && input.resourceInvalidation
        ? createPluginSurfaceResourceWatchHandlers({
            pluginId: input.surfaceContext.pluginId,
            resource: input.resource,
            deliver: input.resourceInvalidation.deliver,
            ...(input.resourceInvalidation.transport
                ? { transport: input.resourceInvalidation.transport }
                : {}),
            ...(input.resourceLifetimeSignal
                ? { lifetimeSignal: input.resourceLifetimeSignal }
                : {}),
            ...(input.isCurrent ? { isCurrent: input.isCurrent } : {}),
        })
        : null;
    const localHostHandlers = createPluginSurfaceLocalHostHandlers({
        surfaceContext: input.surfaceContext,
        ...(input.isCurrent ? { isCurrent: input.isCurrent } : {}),
    });
    const mountedDisposeHostResource = input.mountedHostApiHandlers?.disposeHostResource;
    const resourceDisposeHostResource = resourceWatch?.disposeHostResource;
    return createPluginSurfaceHostApi({
        surfaceContext: input.surfaceContext,
        ...(input.isMethodAvailable ? { isMethodAvailable: input.isMethodAvailable } : {}),
        ...(input.isCurrent ? { isCurrent: input.isCurrent } : {}),
        handlers: {
            ...input.mountedHostApiHandlers,
            ...localHostHandlers,
            executeAction: createPluginSurfaceActionDispatchHandler({
                pluginId: input.surfaceContext.pluginId,
                contributionId: input.surfaceContext.contributionId,
                ...(input.callerBinding ? { callerBinding: input.callerBinding } : {}),
                ...(input.hostAction ? { hostAction: input.hostAction } : {}),
                ...(input.contributedAction ? { contributedAction: input.contributedAction } : {}),
                ...(input.clientAction
                    ? {
                        clientAction: {
                            ...input.clientAction,
                            ...(input.openSurface ? { openSurface: input.openSurface } : {}),
                            ...(feedback.requestCurrentIntent
                                ? { requestCurrentIntent: feedback.requestCurrentIntent }
                                : {}),
                        },
                    }
                    : {}),
                ...(input.invocationSurface ? { invocationSurface: input.invocationSurface } : {}),
                ...(input.resolveContributedAction
                    ? { resolveContributedAction: input.resolveContributedAction }
                    : {}),
                ...(input.isContributedActionAvailable
                    ? { isContributedActionAvailable: input.isContributedActionAvailable }
                    : {}),
                ...(input.isCurrent ? { isCurrent: input.isCurrent } : {}),
            }),
            notify: feedback.notify,
            confirm: feedback.confirm,
            ...(input.resource
                ? {
                    readResource: createPluginSurfaceResourceReadHandler({
                        pluginId: input.surfaceContext.pluginId,
                        resource: input.resource,
                        ...(input.resourceLifetimeSignal
                            ? { lifetimeSignal: input.resourceLifetimeSignal }
                            : {}),
                        ...(input.isCurrent ? { isCurrent: input.isCurrent } : {}),
                    }),
                }
                : {}),
            ...(resourceWatch ? { watchResource: resourceWatch.watchResource } : {}),
            ...(resourceDisposeHostResource || mountedDisposeHostResource
                ? {
                    disposeHostResource: async (request, options) => {
                        const mountedResult = mountedDisposeHostResource
                            ? await mountedDisposeHostResource(request, options)
                            : null;
                        const resourceResult = resourceDisposeHostResource
                            ? await resourceDisposeHostResource(request)
                            : null;
                        return resourceResult ?? mountedResult;
                    },
                }
                : {}),
            ...(input.openSurface
                ? {
                    openSurface: createPluginSurfaceOpenSurfaceHandler(
                        input.openSurface,
                        input.isCurrent,
                    ),
                }
                : {}),
            ...(input.selectActionInput
                ? { selectActionInput: input.selectActionInput }
                : {}),
        },
        onDispose: () => {
            resourceWatch?.dispose();
            feedback.dispose();
            input.disposeMountedHostApiHandlers?.();
        },
    });
}
