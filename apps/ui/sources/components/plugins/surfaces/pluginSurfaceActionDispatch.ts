import {
    PluginInvocableActionIdSchema,
    buildQualifiedPluginContributionKey,
    pluginJsonValuesEqual,
    type ActionExecuteResult,
    type ActionExecutorContext,
    type ActionId,
    type DaemonPluginStructuredMessageActionInvocationV1,
    type DaemonPluginStructuredMessageActionMountedBinding,
    type InteractionTransientRequesterV1,
    type MessageActionReferenceV1,
    PluginMachineMaterializationRefV1Schema,
    type PluginJsonValueV2,
} from '@happier-dev/protocol';
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
    PluginUiMountedActionReferenceV1,
    PluginUiResourceSubscriptionEventV1,
    PluginUiSelectActionInputResultV1,
    PluginUiSurfaceContextV1,
    PluginUiTargetedContributionOperationV1,
} from '@happier-dev/protocol/plugins/ui';

import { machinePluginStructuredMessageActionExecute } from '@/sync/ops/machineContributionRegistryProjection';

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
 * `executionSurface: 'ui'` on the contributed-action front door, and that stamp is
 * an INVARIANT of this dispatcher — it is deliberately absent from every caller
 * binding, so no mount or transport can omit or downgrade it.
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

export type PluginSurfaceActionDispatchOutcome =
    | Readonly<{ ok: true; result: PluginUiJsonValueV1 }>
    | Readonly<{ ok: false; code: PluginUiHostApiErrorCodeV1; reason: string }>;

export type DispatchPluginSurfaceActionInput = Readonly<{
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

function failure(
    code: PluginUiHostApiErrorCodeV1,
    reason: string,
): PluginSurfaceActionDispatchOutcome {
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
    return settledFailure(input, failure('unavailable', result.errorCode));
}

async function executeContributedAction(
    input: DispatchPluginSurfaceActionInput,
): Promise<PluginSurfaceActionDispatchOutcome> {
    if (input.isContributedActionAvailable?.() === false) {
        return failure('unavailable', 'plugin_surface_contributed_action_unavailable');
    }
    const binding = input.contributedAction;
    if (!binding) return failure('unavailable', 'plugin_surface_contributed_action_unavailable');

    const identity = resolveContributedActionIdentity(input);
    if (!identity) return failure('invalid_payload', 'plugin_surface_action_reference_invalid');
    const hasMountedContribution = Boolean(readString(input.callerContributionLocalId));
    const caller = hasMountedContribution
        ? resolveMountedPluginActionCaller(input)
        : null;
    if (hasMountedContribution && !caller) {
        return failure('unavailable', 'plugin_mounted_caller_unavailable');
    }
    if (caller && caller.materialization.machineId !== binding.machineId) {
        return failure('unavailable', 'plugin_mounted_caller_unavailable');
    }
    if (caller && input.invocation) {
        return failure('invalid_payload', 'plugin_surface_action_invocation_ambiguous');
    }

    const execute = binding.execute ?? machinePluginStructuredMessageActionExecute;
    const directTargetedOperation = input.targetedOperation
        && matchesTargetedOperationAction(input.action, input.targetedOperation)
        ? input.targetedOperation
        : undefined;
    if (
        input.targetedOperation
        && input.selectedActionInput
        && (
            !caller
            || input.selectedActionInput.selection.target.pluginId !== caller.pluginId
            || (
                !directTargetedOperation
                && identity.pluginId !== caller.pluginId
            )
        )
    ) {
        // A selected settlement is anchored to the exact mounted target. Its
        // own admitted Action may run directly, but a relay may only invoke a
        // management Action owned by that same target; another contributor
        // cannot borrow the carrier.
        return failure('invalid_payload', 'plugin_surface_targeted_selection_invalid');
    }
    let actionInput = input.input;
    if (directTargetedOperation && input.selectedActionInput) {
        if (
            actionInput === undefined
            || !pluginJsonValuesEqual(actionInput, input.selectedActionInput.input)
        ) {
            return failure('invalid_payload', 'plugin_surface_targeted_selection_invalid');
        }
        const reconstructed = reconstructPluginUiSelectedActionInput(input.selectedActionInput);
        if (!reconstructed) {
            return failure('invalid_payload', 'plugin_surface_targeted_selection_input_invalid');
        }
        actionInput = reconstructed;
    }
    const expectedImmutableGenerationId = directTargetedOperation
        ? directTargetedOperation.contributor.immutableGenerationId
        : binding.expectedImmutableGenerationId;
    const result = await execute(binding.machineId, {
        serverId: binding.serverId ?? null,
        expectedGeneration: binding.expectedGeneration,
        qualifiedActionId: buildQualifiedPluginContributionKey(identity),
        ...(actionInput === undefined
            ? {}
            : {
                // The SDK makes JSON containers readonly for authors while
                // Protocol's equivalent recursive JSON type is mutable. The
                // RPC owner immediately schema-parses this same value.
                input: actionInput as PluginJsonValueV2,
            }),
        // UI-D26: the dispatcher owns this stamp; no caller can omit it.
        executionSurface: 'ui',
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
        ...(input.targetedOperation && input.selectedActionInput && !directTargetedOperation
            ? {
                selectedActionInputCarrier: {
                    operation: input.targetedOperation,
                    result: input.selectedActionInput,
                },
            }
            : {}),
        ...(input.signal ? { signal: input.signal } : {}),
    });

    if (!result.supported) {
        return settledFailure(input, failure('unavailable', 'plugin_ui_action_host_unavailable'));
    }
    if (result.result.ok) {
        // The daemon response is the canonical action settlement. Once it reports
        // success, a later local abort or generation observation must not hide an
        // outward result already known — that would invite a blind mutation retry.
        return { ok: true, result: result.result.result as PluginUiJsonValueV1 };
    }
    return settledFailure(input, failure('unavailable', result.result.code));
}

/**
 * A failed settlement re-reads cancellation/currentness so the caller learns the
 * more specific reason. A SUCCESSFUL settlement is never reinterpreted.
 */
function settledFailure(
    input: DispatchPluginSurfaceActionInput,
    outcome: PluginSurfaceActionDispatchOutcome,
): PluginSurfaceActionDispatchOutcome {
    return preflightFailure(input) ?? outcome;
}

export type CreatePluginSurfaceActionDispatchHandlerInput = Readonly<{
    pluginId: string;
    /** Exact declaring contribution from the bound mount's validated context. */
    contributionId?: string;
    callerBinding?: PluginSurfaceActionMountedBinding;
    hostAction?: PluginSurfaceHostActionBinding;
    contributedAction?: PluginSurfaceContributedActionBinding;
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
            return { code: 'invalid_payload', diagnostics: ['plugin_surface_action_payload_invalid'] };
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
                return {
                    code: 'invalid_payload',
                    diagnostics: ['plugin_surface_targeted_selection_invalid'],
                };
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
            ...(input.isContributedActionAvailable
                ? { isContributedActionAvailable: input.isContributedActionAvailable }
                : {}),
            ...(options?.signal ? { signal: options.signal } : {}),
            ...(targetedOperation ? { targetedOperation } : {}),
            ...(selectedActionInput ? { selectedActionInput } : {}),
            ...(input.isCurrent ? { isCurrent: input.isCurrent } : {}),
        });
        // The dispatcher preserves a success that the canonical Action owner or
        // daemon already observed: rewriting that fact would invite a blind
        // retry. The mounted host still cannot deliver that success into a
        // retired renderer, Account, generation, or instance. This is the one
        // delivery-boundary fence for the pure dispatcher result.
        if (outcome.ok && input.isCurrent?.() === false) {
            return {
                code: 'stale_surface',
                diagnostics: ['plugin_ui_generation_retired_after_dispatch'],
            };
        }
        return outcome.ok
            ? outcome.result
            : { code: outcome.code, diagnostics: [outcome.reason] };
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
