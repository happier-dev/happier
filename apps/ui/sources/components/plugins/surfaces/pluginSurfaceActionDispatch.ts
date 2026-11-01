import { executePreparedPluginSurfaceAction, type PluginSurfaceSpokenActionRequest } from './pluginSurfaceActionPreparation';
import { getActionSpec, isPluginActionCallerPolicySatisfied, PluginInvocableActionIdSchema } from '@happier-dev/protocol/actions/actionSpecs';
import { PLUGIN_ACTION_CURRENT_INTENT_REJECTED_CODE, PLUGIN_ACTION_OUTCOME_UNKNOWN_CODE, createPluginActionInvocation, createPluginActionPresentUserGate, pluginActionRequiresPresentUserIntent, projectPluginActionUnavailableOutcomeCode, readPluginActionFailureAuthorPayload, type PluginActionCurrentIntentRequest, type PluginActionCurrentIntentResult } from '@happier-dev/protocol/plugins/actions/invocation';
import { buildQualifiedPluginContributionKey, type PluginContributionIdentityV1 } from '@happier-dev/protocol/plugins/contribution-identity';
import { formatQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import { pluginJsonValuesEqual } from '@happier-dev/protocol/plugins/contributions/jsonSchemaValues';
import { evaluateContributionAvailability, resolveInvocationContributionPolicyFacts } from '@happier-dev/protocol/plugins/contributions/public-types';
import { pluginSourceCustodyV1Equal, type PluginSourceCustodyV1 } from '@happier-dev/protocol/plugins/runtime/sourceCustody';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ActionExecutorContext, ActionExecutorDeps, ActionPrepareResult } from '@happier-dev/protocol/actions/executor/types';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import { resolveInvocationAuthority } from '@happier-dev/protocol/actions/invocationAuthority';
import { isActionEnabledByActionsSettings } from '@happier-dev/protocol/actions/actionSettings';
import type { ActionRequiredAuthority } from '@happier-dev/protocol/actions/metadata';
import type { ActionOperationDeclarationV1 } from '@happier-dev/protocol/actions/operations/v1';
import type { DaemonPluginStructuredMessageActionInvocationV1, DaemonPluginStructuredMessageActionMountedBinding } from '@happier-dev/protocol/plugins/actions/daemonInvocationV1';
import type { InteractionTransientRequesterV1 } from '@happier-dev/protocol/plugins/interactions/transientV1';
import { MessageActionAvailableSnapshotV1Schema, type MessageActionAvailableSnapshotV1, type MessageActionReferenceV1 } from '@happier-dev/protocol/sessions/messages/messageActionReferenceV1';
import { PluginMachineMaterializationRefV1Schema } from '@happier-dev/protocol/plugins/availability/materializationRefV1';
import type { PluginJsonValueV2 } from '@happier-dev/protocol/plugins/contributions/jsonSchema';
import { PluginError } from '@happier-dev/plugin-sdk';
import type { PluginReference } from '@happier-dev/plugin-sdk';
import { qualifyPluginContributionReferenceV1 } from '@happier-dev/protocol/plugins/contribution-identity';
import {
    readPluginActionInputParser,
    readPluginActionResultParser,
} from '@happier-dev/plugin-sdk/host/registration';
import type {
    PluginActionInvocationSurfaceV2,
    PluginClientActionHandler,
    PluginClientActionUi,
    PluginAccountActionHandler,
} from '@happier-dev/plugin-sdk/actions';
import type { PluginUiActionExecutionOptions, PluginUiHostApi } from '@happier-dev/plugin-sdk/ui';
import type { PluginUiResourceStore } from '@happier-dev/plugin-ui/advanced';
import {
    normalizePluginUiMountedContributedActionReferenceV1,
    PluginUiExecuteActionRequestV1Schema,
    PluginUiQualifiedActionReferenceV1Schema,
    pluginUiSelectedActionInputMatchesOperation,
    reconstructPluginUiSelectedActionInput,
    PluginUiSelectActionInputResultV1Schema,
    PluginUiSelectActionInputRequestV1Schema,
    PLUGIN_UI_HOST_API_VERSION_V1,
    PLUGIN_UI_HOST_API_WIRE_VERSION_V1,
} from '@happier-dev/protocol/plugins/ui';
import type {
    PluginUiHostApiErrorPayloadV1,
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

import {
    machinePluginActionSchemasRead,
    machinePluginStructuredMessageActionExecute,
    machinePluginUiTargetedContributionsRead,
    machineContributionRegistryProjectionDescribe,
} from '@/sync/ops/machineContributionRegistryProjection';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import {
    resolvePluginUiClientActionRegistration,
    type PluginUiClientExecutableRegistration,
} from '@/components/plugins/reactNative/clientExecutableContributions';
import { resolvePluginUiClientExecutablePlatform } from '@/sync/domains/plugins/ui/usePluginUiProjectionCurrentness';
import { readPluginUiAccountExecutableOrigin } from '@/components/plugins/reactNative/executableModuleHost';
import { readPluginAccountAvailability } from '@/sync/domains/plugins/availability/projection';
import { createPluginActionHandlerNotStartedError } from '@happier-dev/plugin-sdk/host/registration';
import {
    isPluginProjectedActionExecutable,
    type PluginUiActionProjection,
    type PluginUiProjectionModel,
    createPluginUiProjectedActionResolver,
} from '@/sync/domains/plugins/ui/projection';
import { publishDaemonMergedProjectionInputs } from '@/agents/backendCatalog/daemonContributionRegistryProjectionAdapters';
import { createSelectedActionInputCustody } from '../hostApi/selectedActionInputCustody';
import { createPluginActionInputSelector } from './pluginActionInputSelectionHostApi';

import { isActionApprovalRequiredInState, resolveActionsSettingsV1FromState } from '@/sync/domains/settings/actionsSettings';
import { getStorage } from '@/sync/domains/state/storageStore';
import { getCurrentAuth } from '@/auth/context/currentAuth';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';

import {
    createPluginActionCurrentIntentHandler,
    createPluginSurfaceFeedbackHandlers,
} from './pluginSurfaceFeedback';
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
    readPluginSurfaceHostApiErrorPayload,
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
import { mergeAbortSignals } from '@/utils/runtime/abortSignals';
import { getPluginUiEphemeralSharedScope } from './pluginUiEphemeralSharedScope';
import { createPluginOpenNewSessionHandler } from './pluginOpenNewSessionHostApi';
import {
    getMachineContributionRegistryProjectionRevision,
    publishMachineContributionRegistryProjectionInvalidation,
    type MachineContributionRegistryProjectionScope,
} from '@/sync/ops/machineContributionRegistryProjectionRevision';
import { resolveReasonCopy } from '@/sync/domains/surfaces/copy';
import { createPluginSurfaceAccountActionServices } from './pluginSurfaceAccountActionServices';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';

/** Exact producer-owned mounted binding, preserved only until RPC projection. */
export type PluginSurfaceActionMountedBinding = DaemonPluginStructuredMessageActionMountedBinding;

/** A host control may carry current Composer/Message intent, never a mount binding. */
export type PluginSurfaceHostPresentedActionInvocation = Extract<
    DaemonPluginStructuredMessageActionInvocationV1,
    Readonly<{ kind: 'hostPresentedComposer' | 'hostPresentedMessage' }>
>;
type PluginSurfaceUnMountedActionInvocation = Exclude<
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

export type PluginSurfaceHostActionExecute = ((
    actionId: ActionId,
    input: unknown,
    context?: ActionExecutorContext,
) => Promise<ActionExecuteResult>) & Readonly<{
    prepare?: (actionId: ActionId, input: unknown, context?: ActionExecutorContext) => Promise<ActionPrepareResult>;
}>;

/** Branch 1 wiring: the canonical ActionExecutor plus the host front-door context. */
export type PluginSurfaceActionExecutorContext = ActionExecutorContext & Readonly<{
    /** The live mount's presentation capability, carried only through this in-process invocation. */
    requestContributedActionCurrentIntent?: PluginSurfaceActionCurrentIntentPresenter;
    /** Existing caller and selected-operation custody retained across canonical in-process dispatch. */
    contributedActionInvocation?: Readonly<{
        /** Exact live declaration and continuation; private to this host preparation. */
        listContributedActionDefinitions?: NonNullable<ActionExecutorDeps['listContributedActionDefinitions']>;
        resume?: (request: Parameters<NonNullable<ActionExecutorDeps['invokeContributedAction']>>[0],
            hostAction: PluginSurfaceHostActionBinding) => Promise<ActionExecuteResult>;
        caller: Pick<DispatchPluginSurfaceActionInput, 'callerPluginId' | 'callerContributionLocalId'
            | 'callerBinding' | 'callerSourceCustody' | 'invocation' | 'actionRequestId' | 'onDaemonActionOperationAdmitted'
            | 'targetedOperation' | 'selectedActionInput' | 'isContributedActionAvailable' | 'onPreInvocationMachineRefusal'>;
        contributedAction?: PluginSurfaceContributedActionBinding;
        clientAction?: PluginSurfaceClientActionBinding;
        signal?: AbortSignal;
        isCurrent?: () => boolean;
    }>;
}>;

export type PluginSurfaceHostActionBinding = Readonly<{
    execute: PluginSurfaceHostActionExecute;
    context?: PluginSurfaceActionExecutorContext;
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
) => PluginUiActionProjection | null;

/**
 * Branch 2 wiring. Note the absence of `executionSurface`: the stamp belongs to
 * the dispatcher, so a caller can neither omit nor downgrade it (UI-D26).
 */
export type PluginSurfaceContributedActionBinding = Readonly<{
    machineId: string;
    serverId?: string | null;
    /** Borrowed host authority, never part of the plugin invocation DTO. */
    accountLifetime?: ServerAccountScopeLifetime | null;
    sessionId?: string;
    /** Opaque server-issued message identity, resolved by the daemon before dispatch. */
    messageActionReference?: MessageActionReferenceV1;
    timeoutMs?: number;
    execute?: PluginSurfaceContributedActionTransport;
}>;

/** UI dispatch can originate from an interactive surface or the Voice bridge. */
export type PluginSurfaceActionInvocationSurface = Extract<
    PluginActionInvocationSurfaceV2,
    'ui' | 'voice' | 'agent' | 'mcp' | 'cli' | 'plugin'
>;

/**
 * Exact non-daemon facts for one client-targeted Action invocation. The generic
 * executable composition remains the registration/index owner; this binding
 * provides only the caller's current projection and incumbent UI capabilities.
 */
export type PluginSurfaceClientActionBinding = Readonly<{
    /** Optional transport adapter only; exact routing comes from the selected registration. */
    execute?: PluginSurfaceContributedActionTransport;
    sessionId?: string;
    openSurface?: PluginSurfaceOpenHandler;
    currentUiContext?: () => CurrentUiContextSnapshotV1 | null | undefined;
    /** Opaque committed identity; resolved after the client's Action admission. */
    messageActionReference?: MessageActionReferenceV1;
}>;

/** The incumbent UI confirmation lifecycle, bound to one presenting owner. */
export type PluginSurfaceActionCurrentIntentPresenter = (
    request: PluginActionCurrentIntentRequest<PluginUiActionProjection>,
) => Promise<PluginActionCurrentIntentResult>;

export type { PluginSurfaceActionDispatchOutcome } from './actionFailure';
import { createPluginSurfaceActionFailure as failure, clientActionFailure, actionDeclinedFailure, actionOutcomeUnknownFailure, type PluginSurfaceActionDispatchOutcome } from './actionFailure';

export type DispatchPluginSurfaceActionInput = Readonly<{
    /** Host-only placement for an effect already owned by a mounted Account client. */
    admissionOnly?: true;
    /** Exact host request identity for Action approval custody and daemon operation observation. */
    actionRequestId?: string;
    /** Host-local spoken intent; the shared Action front door decides authority. */
    spokenActionRequest?: PluginSurfaceSpokenActionRequest;
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
    /** Producer-owned custody of the exact mounted caller, including deferred host approvals. */
    callerSourceCustody?: PluginSourceCustodyV1;
    action: PluginUiMountedActionReferenceV1;
    input?: PluginUiJsonValueV1;
    hostAction?: PluginSurfaceHostActionBinding;
    contributedAction?: PluginSurfaceContributedActionBinding;
    /** Exact client-side projection/lifecycle binding; never a daemon fallback. */
    clientAction?: PluginSurfaceClientActionBinding;
    /**
     * A mounted surface's own confirmation presenter (its requester and
     * retirement). Absent, the dispatcher presents the same app-shell
     * confirmation for the Action itself. Either way the dispatcher alone
     * decides whether the person is asked, for both execution placements.
     */
    requestCurrentIntent?: PluginSurfaceActionCurrentIntentPresenter;
    /** Admitted UI projection; resolves the author's confirmation wording. */
    pluginUiProjection?: PluginUiProjectionModel | null;
    /** UI is the default; Voice supplies its own canonical invoking surface. */
    invocationSurface?: PluginSurfaceActionInvocationSurface;
    /** Host-private root origin, retained across autonomous plugin continuations. */
    originSurface?: Exclude<PluginSurfaceActionInvocationSurface, 'plugin'>;
    /**
     * The current raw V2 Action projection. Target selection belongs to this
     * producer-owned descriptor, never to a daemon binding or caller-local
     * availability predicate.
     */
    resolveContributedAction?: PluginSurfaceContributedActionDescriptorResolver;
    /** Exact source retained by an admitted targeted-operation handle, never author supplied. */
    expectedContributorOccurrenceId?: string;
    /**
     * Exact present-user host intent. Mounted provenance is derived here from
     * the bound controller's private caller binding; a host control cannot
     * publish or manufacture that third union arm.
     */
    invocation?: PluginSurfaceUnMountedActionInvocation;
    /** Live daemon capability owned by the bound controller, never a new action owner. */
    isContributedActionAvailable?: () => boolean;
    /** Reuse the mounted facade's connection settlement before a daemon invocation. */
    settleContributedAction?: PluginSurfaceContributedActionSettlement;
    /** Exact local refusal phase; never inherited by an entered caller's nested Action. */
    onPreInvocationMachineRefusal?: () => void;
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

type PluginSurfaceContributedActionSettlement = (
    identity: PluginContributionIdentityV1,
    options: Readonly<{ signal?: AbortSignal; requestId?: string }>,
) => Promise<Readonly<{ ok: true; binding: PluginSurfaceContributedActionBinding | undefined }> | PluginSurfaceActionDispatchFailure>;

/** Keep the public failure envelope when an Action is called by plugin code. */
function pluginActionDispatchFailureError(outcome: PluginSurfaceActionDispatchFailure): PluginError {
    return new PluginError({
        code: outcome.reason === 'plugin_ui_action_outcome_unknown'
            ? PLUGIN_ACTION_OUTCOME_UNKNOWN_CODE : outcome.reason,
        ...(outcome.message === undefined ? {} : { message: outcome.message }),
        ...(outcome.retryable === undefined ? {} : { retryable: outcome.retryable }),
        ...(outcome.remediation === undefined ? {} : { remediation: outcome.remediation }),
    });
}

function readActionOriginSurface(input: DispatchPluginSurfaceActionInput) {
    const surface = input.invocationSurface ?? 'ui';
    return input.originSurface ?? (surface === 'plugin' ? null : surface);
}

/** A daemon refusal withdraws the old projection, never replays its Action. */
function staleDaemonProjectionFailure(
    code: string,
    scope: MachineContributionRegistryProjectionScope,
    revision: number,
    accountLifetime?: ServerAccountScopeLifetime | null,
): PluginSurfaceActionDispatchFailure | null {
    if (code !== 'plugin_generation_stale'
        && code !== 'plugin_occurrence_stale'
        && code !== 'plugin_action_generation_retired') return null;
    // A concurrent refusal or reconnect may already have requested the new
    // projection. Keep recovery with that existing currentness observation.
    if ((accountLifetime === undefined || accountLifetime?.isCurrent() === true)
        && getMachineContributionRegistryProjectionRevision(scope) === revision) {
        publishMachineContributionRegistryProjectionInvalidation(scope);
    }
    return failure('stale_surface', code, {
        message: resolveReasonCopy({ kind: 'pluginRuntime', reasonCode: code }).body,
    });
}

function readString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

type MountedPluginActionCaller = Readonly<{
    pluginId: string;
    contributionLocalId: string;
    occurrenceId: string;
    materialization?: ReturnType<typeof PluginMachineMaterializationRefV1Schema.parse>;
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
    const occurrenceId = readString(mountedBinding.occurrenceId);
    const materialization = mountedBinding.materializationRef === undefined
        ? null
        : PluginMachineMaterializationRefV1Schema.safeParse(mountedBinding.materializationRef);
    if (
        !occurrenceId
        || mountedBinding.pluginId !== pluginId
        || mountedBinding.contributionLocalId !== contributionLocalId
        || (materialization !== null && !materialization.success)
        || (materialization?.success === true && materialization.data.pluginId !== pluginId)
        || (
            input.contributedAction !== undefined
            && materialization?.success === true
            && materialization.data.machineId !== input.contributedAction.machineId
        )
    ) {
        return null;
    }
    return Object.freeze({
        pluginId,
        contributionLocalId,
        occurrenceId,
        ...(materialization?.success === true ? { materialization: materialization.data } : {}),
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
): PluginUiActionProjection | null {
    try {
        const action = input.resolveContributedAction?.(identity) ?? null;
        return isPluginProjectedActionExecutable(action)
            && action.pluginId === identity.pluginId
            && action.id === identity.localId
            && (input.expectedContributorOccurrenceId === undefined
                || action.occurrenceId === input.expectedContributorOccurrenceId)
            ? action
            : null;
    } catch {
        return null;
    }
}

type ClientContributedActionSelection = Readonly<{
    action: PluginUiActionProjection;
    authorization: NonNullable<PluginUiActionProjection['authorization']>;
    binding: PluginSurfaceClientActionBinding;
    registration: PluginUiClientExecutableRegistration;
    /** Opaque generic-registration value, narrowed at the public SDK boundary. */
    handler: PluginClientActionHandler | PluginAccountActionHandler;
    pluginVersion: string;
    isCurrent: () => boolean;
}>;

function clientActionInvocation(selection: ClientContributedActionSelection): Extract<
    DaemonPluginStructuredMessageActionInvocationV1, { kind: 'clientPluginAction' }
> {
    const accountOrigin = readPluginUiAccountExecutableOrigin(selection.action);
    return {
        kind: 'clientPluginAction',
        clientActionBinding: {
            pluginId: selection.action.pluginId,
            contributionLocalId: selection.action.id,
            occurrenceId: selection.registration.occurrenceId,
            ...(accountOrigin ? { sourceCustody: accountOrigin.sourceCustody, pluginVersion: selection.pluginVersion } : {}),
            // Source-backed development occurrences have no materialization.
            ...(selection.registration.executionOrigin && 'materializationRef' in selection.registration.executionOrigin
                ? { materializationRef: selection.registration.executionOrigin.materializationRef } : {}),
        },
    };
}

/**
 * Reads one Action from the producer-owned generic executable index. The raw
 * descriptor, exact target/origin and registration generation must all remain
 * current together; no client registration can be reconstructed or substituted
 * by a caller-local availability predicate.
 */
function resolveClientContributedActionSelection(
    input: DispatchPluginSurfaceActionInput,
    identity: PluginContributionIdentityV1,
    expectedAction: PluginUiActionProjection,
): ClientContributedActionSelection | null {
    const binding = input.clientAction;
    if (
        !binding
    ) {
        return null;
    }
    const action = resolveProjectedContributedAction(input, identity);
    if (
        action !== expectedAction
        || action.execution.target === 'daemon'
        || !action.authorization
    ) {
        return null;
    }
    const platform = resolvePluginUiClientExecutablePlatform();
    const resolvedRegistration = resolvePluginUiClientActionRegistration({
        action,
        platform,
    });
    if (!resolvedRegistration) return null;
    const { registration, handler, pluginVersion, authorization } = resolvedRegistration;
    const isCurrent = (): boolean => {
        if (input.isCurrent?.() === false) return false;
        if (!isContributedActionEnabled(identity, input.invocationSurface ?? 'ui')) return false;
        if (!registration.lifecycle.isCurrent() || registration.lifecycle.signal.aborted) return false;
        if (registration.accountLifetime?.isCurrent() === false) return false;
        if (resolveProjectedContributedAction(input, identity) !== expectedAction) return false;
        return resolvePluginUiClientActionRegistration({
            action: expectedAction,
            platform,
        })?.registration === registration;
    };
    return isCurrent()
        ? Object.freeze({ action, authorization, binding, registration, handler, pluginVersion, isCurrent })
        : null;
}

function clientActionOpenSurface(
    selection: ClientContributedActionSelection,
    invocationSignal: AbortSignal,
): PluginUiHostApi['openSurface'] {
    return async (view: PluginReference, actionInput, options): Promise<void> => {
        if (!selection.isCurrent()) {
            throw new PluginError({ code: 'plugin_action_generation_retired' });
        }
        if (invocationSignal.aborted || options?.signal?.aborted) {
            throw new PluginError({ code: 'plugin_action_aborted' });
        }
        const openSurface = selection.binding.openSurface;
        if (!openSurface) {
            throw new PluginError({ code: 'plugin_surface_open_unavailable' });
        }
        // The shared identity owner only qualifies this bare reference. It
        // adapts the Action capability to the incumbent navigation owner; it
        // does not resolve a route or create a second surface owner.
        const destination = qualifyPluginContributionReferenceV1(
            view,
            selection.action.pluginId,
        );
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

function clientActionExecuteAction(
    input: DispatchPluginSurfaceActionInput,
    selection: ClientContributedActionSelection,
    invocationSignal: AbortSignal,
    selectedInputs: ReturnType<typeof createSelectedActionInputCustody>,
): PluginUiHostApi['executeAction'] {
    // Dynamic dispatch validates each selected Action's input schema; the SDK
    // generic result relationship is restored at this host boundary.
    return (async (action: PluginReference, actionInput?: PluginUiJsonValueV1, options?: PluginUiActionExecutionOptions) => {
        if (!selection.isCurrent()) {
            throw new PluginError({ code: 'plugin_action_generation_retired' });
        }
        const cancellation = mergeAbortSignals([invocationSignal, options?.signal]);
        try {
            const consume = (options as (PluginUiActionExecutionOptions & Readonly<{ consumeSelectedActionInput?: unknown }>) | undefined)
                ?.consumeSelectedActionInput === true;
            const custody = selectedInputs.settle(action, options?.selectedActionInput, consume);
            if (!custody.ok) throw new PluginError({ code: 'plugin_surface_targeted_selection_invalid' });
            const selected = custody.selected;
            // Activation already bound this exact transport authority. The
            // outer adapter may supply a transport implementation, never the
            // machine/generation of a different ambient projection.
            const registeredAuthority = selection.registration.authority;
            const authority = registeredAuthority && 'machineId' in registeredAuthority ? registeredAuthority : undefined;
            const execute = selection.binding.execute ?? input.contributedAction?.execute;
            const contributedAction = authority ? {
                machineId: authority.machineId,
                serverId: authority.serverId,
                ...(selection.binding.sessionId ? { sessionId: selection.binding.sessionId } : {}),
                ...(execute ? { execute } : {}),
            } : undefined;
            const outcome = await dispatchPluginSurfaceAction({
                callerPluginId: selection.action.pluginId,
                ...(selected ? {
                    callerSourceCustody: selected.carrier.result.selection.target.sourceCustody,
                    targetedOperation: selected.carrier.operation,
                    selectedActionInput: selected.carrier.result,
                } : {}),
                action,
                ...(actionInput === undefined ? {} : { input: actionInput }),
                ...(input.hostAction === undefined ? {} : { hostAction: input.hostAction }),
                ...(contributedAction === undefined ? {} : { contributedAction }),
                clientAction: selection.binding,
                ...(input.resolveContributedAction === undefined
                    ? {}
                    : { resolveContributedAction: input.resolveContributedAction }),
                invocationSurface: input.invocationSurface ?? 'ui',
                ...(input.originSurface ? { originSurface: input.originSurface } : {}),
                invocation: clientActionInvocation(selection),
                signal: cancellation.signal,
                isCurrent: selection.isCurrent,
            });
            if (!outcome.ok) throw pluginActionDispatchFailureError(outcome);
            return outcome.result;
        } finally {
            cancellation.dispose();
        }
    }) as PluginUiHostApi['executeAction'];
}

function createClientActionUi(
    input: DispatchPluginSurfaceActionInput,
    selection: ClientContributedActionSelection,
    signal: AbortSignal,
) {
    const selectedInputs = createSelectedActionInputCustody();
    const registeredAuthority = selection.registration.authority;
    const authority = registeredAuthority && 'machineId' in registeredAuthority ? registeredAuthority : undefined;
    const accountLifetime = selection.registration.accountLifetime;
    const executeAction = clientActionExecuteAction(input, selection, signal, selectedInputs);
    const isCurrent = () => selection.isCurrent() && !signal.aborted;
    function assertCurrent() {
        if (!selection.isCurrent()) throw new PluginError({ code: 'plugin_action_generation_retired' });
        if (signal.aborted) throw new PluginError({ code: 'plugin_action_aborted' });
    }
    const context: PluginClientActionUi['context'] = async (options) => {
        assertCurrent();
        if (!authority || !accountLifetime) return { targetedContributions: null };
        const cancellation = mergeAbortSignals([signal, options?.signal]);
        try {
            const result = await machinePluginUiTargetedContributionsRead(authority.machineId, {
                serverId: authority.serverId,
                pluginId: selection.action.pluginId,
                accountLifetime,
                signal: cancellation.signal,
            });
            assertCurrent();
            if (!result.supported) throw new PluginError({ code: 'plugin_action_target_context_unavailable' });
            if (result.targetedContributions.target.occurrenceId !== selection.registration.occurrenceId) {
                throw new PluginError({ code: 'plugin_action_generation_retired' });
            }
            return { targetedContributions: result.targetedContributions };
        } finally {
            cancellation.dispose();
        }
    };
    const ui: PluginClientActionUi = {
        version: () => ({
            apiVersion: PLUGIN_UI_HOST_API_VERSION_V1,
            wireVersion: PLUGIN_UI_HOST_API_WIRE_VERSION_V1,
            methods: ['context', 'executeAction', ...(authority && accountLifetime ? ['selectActionInput' as const, 'openNewSession' as const] : []),
                ...(selection.binding.openSurface ? ['openSurface' as const] : [])],
        }),
        context,
        selectActionInput: async (request, options) => {
            assertCurrent();
            if (!authority || !accountLifetime) throw new PluginError({ code: 'plugin_action_input_selection_unavailable' });
            const parsed = PluginUiSelectActionInputRequestV1Schema.safeParse(request);
            if (!parsed.success) throw new PluginError({ code: 'plugin_action_input_selection_invalid' });
            const cancellation = mergeAbortSignals([signal, options?.signal]);
            try {
                const targeted = 'operation' in parsed.data ? await context({ signal: cancellation.signal }) : null;
                const projection = 'operation' in parsed.data
                    ? await machineContributionRegistryProjectionDescribe(authority.machineId, {
                        serverId: authority.serverId, accountLifetime, signal: cancellation.signal,
                    })
                    : null;
                assertCurrent();
                if (projection && !projection.supported) throw new PluginError({ code: 'plugin_action_input_selection_unavailable' });
                const selectionInputs = projection?.supported ? publishDaemonMergedProjectionInputs({ projection: projection.projection }) : null;
                const selectionProjection = selectionInputs?.pluginUiProjection ?? null;
                const select = createPluginActionInputSelector({
                    ...(selectionInputs ? {
                        pluginProjectionById: selectionInputs.pluginProjectionById,
                        pluginUiProjection: selectionProjection,
                    } : {}),
                    targetedContributions: targeted?.targetedContributions,
                    ...(selectionProjection ? { resolveContributedAction: createPluginUiProjectedActionResolver(selectionProjection.actionsById) } : {}),
                    host: {
                        machineId: authority.machineId,
                        serverId: authority.serverId,
                        targetPluginId: selection.action.pluginId,
                        sessionId: selection.binding.sessionId,
                        accountLifetime,
                        signal: cancellation.signal,
                        isCurrent,
                    },
                    isCurrent,
                });
                const result = await select(parsed.data, { signal: cancellation.signal });
                const failure = readPluginSurfaceHostApiErrorPayload(result);
                if (failure) throw new PluginError({ code: failure.code });
                const selected = PluginUiSelectActionInputResultV1Schema.safeParse(result);
                if (!selected.success) throw new PluginError({ code: 'plugin_action_input_selection_invalid' });
                if (selected.data.kind === 'submitted' && 'operation' in parsed.data) {
                    selectedInputs.retain(parsed.data.operation, selected.data, options?.signal);
                }
                return selected.data;
            } finally {
                cancellation.dispose();
            }
        },
        executeAction,
        openSurface: clientActionOpenSurface(selection, signal),
        openNewSession: async (request, options) => {
            assertCurrent();
            if (!authority || !accountLifetime) throw new PluginError({ code: 'plugin_action_new_session_unavailable' });
            const retained = options?.preparedReviewWorkspace === undefined ? undefined : selectedInputs.resolve(options.preparedReviewWorkspace);
            if (options?.preparedReviewWorkspace !== undefined && !retained) throw new PluginError({ code: 'plugin_surface_targeted_selection_invalid' });
            const openNewSession = createPluginOpenNewSessionHandler({
                pluginId: selection.action.pluginId,
                accountLifetime,
                lifetimeSignal: signal,
                isCurrent,
                executionTarget: { machineId: authority.machineId, serverId: authority.serverId ?? accountLifetime.scope.serverId },
                executeSelectedOperation: async (payload, operationOptions) => {
                    const executionOptions = {
                        ...(operationOptions?.signal ? { signal: operationOptions.signal } : {}),
                        ...(retained ? { selectedActionInput: retained.carrier, consumeSelectedActionInput: true } : {}),
                    };
                    return await executeAction(payload.action, payload.input, executionOptions);
                },
            });
            const outcome = await openNewSession(request, {
                ...(options?.signal ? { signal: options.signal } : {}),
                ...(retained ? { targetedOperation: retained.carrier.operation, selectedActionInput: retained.carrier.result } : {}),
            });
            const failure = readPluginSurfaceHostApiErrorPayload(outcome);
            if (failure) throw new PluginError({ code: failure.diagnostics?.[0] ?? failure.code });
        },
    };
    return { ui, dispose: selectedInputs.dispose };
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

/**
 * The person's effective Action approval setting for this invocation. The daemon applies
 * the same Account policy at admission; if the two ever disagree, a daemon that
 * requires a decision refuses a request that carries none (fail closed).
 */
function isApprovalRequiredByActionSettings(
    identity: PluginContributionIdentityV1,
    invocationSurface: PluginSurfaceActionInvocationSurface,
    action: Pick<PluginUiActionProjection, 'dangerLevel' | 'confirmation' | 'confirmationWhen'>,
    normalizedInput?: unknown,
    invocationAuthority?: ActionRequiredAuthority,
): boolean {
    try {
        return isActionApprovalRequiredInState(
            getStorage().getState(),
            formatQualifiedPluginActionId({ pluginId: identity.pluginId, localId: identity.localId }),
            { surface: invocationSurface },
            pluginActionRequiresPresentUserIntent(action, invocationSurface, normalizedInput, invocationAuthority),
        );
    } catch {
        // An unreadable settings snapshot cannot waive the person's decision.
        return true;
    }
}

function isContributedActionEnabled(
    identity: PluginContributionIdentityV1,
    surface: PluginSurfaceActionInvocationSurface,
): boolean {
    return isActionEnabledByActionsSettings(
        formatQualifiedPluginActionId(identity),
        resolveActionsSettingsV1FromState(getStorage().getState()),
        { surface },
    );
}

async function contributedInvocationAuthority(
    input: DispatchPluginSurfaceActionInput,
    targetServerId?: string | null,
): Promise<ActionRequiredAuthority> {
    if (input.invocation?.kind === 'clientPluginAction') return 'account_automation';
    if (input.hostAction?.context?.authority) return input.hostAction.context.authority;
    const serverId = (targetServerId ?? input.contributedAction?.serverId ?? input.hostAction?.context?.serverId)?.trim();
    const surface = input.invocationSurface ?? 'ui';
    if (!serverId) return resolveInvocationAuthority({
        credential: getCurrentAuth()?.credentialAuthorityKind ?? 'none', surface,
    });
    try {
        const account = await captureLazyActionAccountContext(serverId, input.signal);
        try {
            account.assertCurrent();
            return resolveInvocationAuthority({ credential: account.credentialAuthorityKind, surface });
        } finally { account.dispose(); }
    } catch {
        // An unavailable target credential cannot inherit the focused Home's authority.
        return 'account_automation';
    }
}

/**
 * The one present-user confirmation presenter for a dispatch. A mounted
 * surface supplies its own; every other UI entry point gets the same app-shell
 * confirmation, requested on behalf of the Action itself.
 */
function resolveCurrentIntentPresenter(
    input: DispatchPluginSurfaceActionInput,
    projectedAction: PluginUiActionProjection,
    invocationSurface: PluginSurfaceActionInvocationSurface,
): PluginSurfaceActionCurrentIntentPresenter {
    return input.requestCurrentIntent ?? createPluginActionCurrentIntentHandler({
        requester: {
            pluginId: projectedAction.pluginId,
            contributionId: projectedAction.id,
            occurrenceId: projectedAction.occurrenceId,
            invocationId: `${invocationSurface}-action:${projectedAction.occurrenceId}`,
        },
        ...(input.signal ? { signal: input.signal } : {}),
        isCurrent: input.isCurrent ?? (() => true),
        pluginUiProjection: input.pluginUiProjection,
    });
}

/**
 * Settles present-user intent for a daemon-target Action before its RPC. The
 * person is asked here, in the UI, exactly when the shared requirement rule
 * says so; the daemon admits the carried result and creates no approval
 * artifact. A decline or an unanswerable dialog sends nothing.
 */
async function settleDaemonActionPresentUserIntent(
    input: DispatchPluginSurfaceActionInput,
    identity: PluginContributionIdentityV1,
    projectedAction: PluginUiActionProjection,
    settledInput: PluginUiJsonValueV1 | undefined,
    preparedInput?: Readonly<{ input: unknown }>,
): Promise<Readonly<{ ok: true; presentUserIntent?: 'confirmed' }> | PluginSurfaceActionDispatchFailure> {
    const invocationSurface = input.invocationSurface ?? 'ui';
    let normalizedInput: unknown = preparedInput?.input;
    if (!preparedInput && projectedAction.confirmationWhen !== undefined && !input.admissionOnly) {
        const binding = input.contributedAction;
        if (!binding) return failure('unavailable', 'plugin_surface_contributed_action_unavailable');
        const projectionScope = { machineId: binding.machineId, serverId: binding.accountLifetime?.scope.serverId ?? binding.serverId ?? null };
        const projectionRevision = getMachineContributionRegistryProjectionRevision(projectionScope);
        const schemas = await machinePluginActionSchemasRead(binding.machineId, {
            serverId: binding.serverId ?? null,
            expectedOccurrenceId: projectedAction.occurrenceId,
            qualifiedActionId: buildQualifiedPluginContributionKey(identity),
            ...(input.signal ? { signal: input.signal } : {}),
        });
        if (!schemas.supported) return failure('unavailable', 'plugin_surface_action_schemas_unavailable');
        if (!schemas.result.ok) return staleDaemonProjectionFailure(schemas.result.code, projectionScope, projectionRevision, binding.accountLifetime)
            ?? failure('unavailable', 'plugin_surface_action_schemas_unavailable');
        const invocation = createPluginActionInvocation({
            pluginId: identity.pluginId, localId: identity.localId,
            inputSchema: schemas.result.inputSchema,
            occurrenceSignal: input.signal ?? new AbortController().signal,
            isCurrent: () => input.isCurrent?.() !== false,
        });
        const prepared = invocation.prepare(settledInput ?? null);
        if (prepared.kind === 'settled') return clientActionFailure(
            'code' in prepared.result ? prepared.result.code : 'plugin_action_input_schema_invalid',
        );
        normalizedInput = prepared.input;
    }
    // A caller-owned writer validates its own input. Until then, its admission
    // uses the declaration's conservative no-input default rather than assuming
    // a condition on unvalidated JSON or requiring a daemon to authorize Account state.
    const invocationAuthority = await contributedInvocationAuthority(input);
    if (!isContributedActionEnabled(identity, invocationSurface)) return failure('denied', 'plugin_action_disabled');
    const approvalRequiredByActionSettings = isApprovalRequiredByActionSettings(identity, invocationSurface, projectedAction, normalizedInput, invocationAuthority);
    if (!pluginActionRequiresPresentUserIntent({
        dangerLevel: projectedAction.dangerLevel,
        ...(projectedAction.confirmation === undefined
            ? {}
            : { confirmation: projectedAction.confirmation }),
        ...(projectedAction.confirmationWhen === undefined ? {} : { confirmationWhen: projectedAction.confirmationWhen }),
        approvalRequiredByActionSettings,
    }, invocationSurface, normalizedInput, invocationAuthority)) {
        return { ok: true };
    }
    // The daemon binds this decision to the exact request it arrives on; this
    // token only correlates the local answer with the question asked here.
    const fingerprint = `${buildQualifiedPluginContributionKey(identity)}@${projectedAction.occurrenceId}`;
    let intent: PluginActionCurrentIntentResult;
    try {
        intent = await resolveCurrentIntentPresenter(input, projectedAction, invocationSurface)({
            action: projectedAction,
            input: normalizedInput === undefined ? settledInput : normalizedInput,
            fingerprint,
            surface: invocationSurface,
            invocationSurface,
            ...(input.signal ? { signal: input.signal } : {}),
        });
    } catch {
        intent = { status: 'unavailable', code: 'plugin_action_current_intent_unavailable' };
    }
    if (input.signal?.aborted) return failure('unavailable', 'plugin_ui_invocation_aborted');
    if (input.isCurrent && !input.isCurrent()) {
        return failure('stale_surface', 'plugin_ui_generation_retired');
    }
    if (!isContributedActionEnabled(identity, invocationSurface)) {
        return failure('denied', 'plugin_action_disabled');
    }
    if (intent.status === 'approved') {
        return intent.fingerprint === fingerprint
            ? { ok: true, presentUserIntent: 'confirmed' }
            : failure('unavailable', 'plugin_action_current_intent_mismatch');
    }
    if (intent.status === 'deferred') {
        return failure('unavailable', 'plugin_action_current_intent_unavailable');
    }
    return failure(
        intent.code === PLUGIN_ACTION_CURRENT_INTENT_REJECTED_CODE
            ? 'denied'
            : intent.code === 'plugin_action_generation_retired' ? 'stale_surface' : 'unavailable',
        intent.code,
    );
}

async function prepareClientContributedAction(
    input: DispatchPluginSurfaceActionInput,
    identity: PluginContributionIdentityV1,
    projectedAction: PluginUiActionProjection,
    settledInput: PluginUiJsonValueV1 | undefined,
) {
    const initial = resolveClientContributedActionSelection(input, identity, projectedAction);
    if (!initial) return failure('unavailable', 'plugin_surface_client_action_unavailable');
    // Caller-supplied input (UI, Voice) is validated against the Action's
    // declared input schema, read per Action from its projecting machine. The
    // plugin is trusted code: its result is not re-validated here.
    const authority = initial.registration.authority;
    if (!authority) return failure('unavailable', 'plugin_surface_client_action_unavailable');
    const invocationAuthority = await contributedInvocationAuthority(input, authority.serverId);
    const accountDeclaration = projectedAction.execution.target === 'account'
        ? projectedAction.accountActionDeclaration : null;
    let inputSchema: Parameters<typeof createPluginActionInvocation>[0]['inputSchema'];
    if (projectedAction.execution.target === 'account') {
        if (!accountDeclaration || !readPluginUiAccountExecutableOrigin(projectedAction)) {
            return clientActionFailure('plugin_surface_account_action_unavailable');
        }
        inputSchema = accountDeclaration.inputSchema ?? {};
    } else {
        if (!('machineId' in authority)) return clientActionFailure('plugin_surface_client_action_unavailable');
        const projectionScope = { machineId: authority.machineId, serverId: authority.serverId };
        const projectionRevision = getMachineContributionRegistryProjectionRevision(projectionScope);
        const schemas = await machinePluginActionSchemasRead(authority.machineId, {
            serverId: authority.serverId,
            expectedOccurrenceId: projectedAction.occurrenceId,
            qualifiedActionId: buildQualifiedPluginContributionKey(identity),
            ...(input.signal ? { signal: input.signal } : {}),
        });
        if (!schemas.supported || !schemas.result.ok) {
            return (schemas.supported && !schemas.result.ok
                ? staleDaemonProjectionFailure(schemas.result.code, projectionScope, projectionRevision, initial.registration.accountLifetime)
                : null) ?? clientActionFailure('plugin_surface_client_action_unavailable');
        }
        inputSchema = schemas.result.inputSchema;
    }
    const invocation = createPluginActionInvocation({
        pluginId: identity.pluginId,
        localId: identity.localId,
        inputSchema,
        ...(readPluginActionInputParser(initial.registration.registration.value) === undefined
            ? {}
            : { inputParser: readPluginActionInputParser(initial.registration.registration.value) }),
        ...(readPluginActionResultParser(initial.registration.registration.value) === undefined
            ? {}
            : { resultParser: readPluginActionResultParser(initial.registration.registration.value) }),
        occurrenceSignal: initial.registration.lifecycle.signal,
        isCurrent: initial.isCurrent,
    });
    const preparedInput = invocation.prepare(settledInput ?? null, { ...(input.signal ? { signal: input.signal } : {}) });
    if (preparedInput.kind === 'settled') return clientActionFailure('code' in preparedInput.result ? preparedInput.result.code : 'plugin_action_input_schema_invalid');
    return { kind: 'prepared' as const, initial, authority, invocationAuthority, invocation, preparedInput };
}

type PreparedClientContributedAction = Extract<Awaited<ReturnType<typeof prepareClientContributedAction>>, { kind: 'prepared' }>;

async function executeClientContributedAction(
    input: DispatchPluginSurfaceActionInput,
    identity: PluginContributionIdentityV1,
    projectedAction: PluginUiActionProjection,
    /** The dispatcher-settled input, already carrying any selected Account ref. */
    preparation: PreparedClientContributedAction,
): Promise<PluginSurfaceActionDispatchOutcome> {
    const { initial, authority, invocationAuthority, invocation, preparedInput } = preparation;
    const invocationSurface = input.invocationSurface ?? 'ui';
    const originSurface = readActionOriginSurface(input);
    if (!originSurface) return failure('unavailable', 'plugin_action_origin_unavailable');
    // Built only if the gate actually asks the person.
    const requestCurrentIntent: PluginSurfaceActionCurrentIntentPresenter = (request) => (
        resolveCurrentIntentPresenter(input, projectedAction, invocationSurface)(request)
    );
    let normalizedInput: unknown = preparedInput.input;
    const presentUserGate = createPluginActionPresentUserGate<PluginUiActionProjection>({
        resolve: () => {
            const current = resolveClientContributedActionSelection(input, identity, projectedAction);
            if (!current || !current.action.authorization) {
                return Object.freeze({
                    status: 'unavailable' as const,
                    code: 'plugin_surface_client_action_unavailable',
                });
            }
            const accountAvailability = current.action.execution.target === 'account'
                ? evaluateContributionAvailability({
                    availability: current.action.accountActionDeclaration?.availability,
                    facts: resolveInvocationContributionPolicyFacts({
                        sessionId: current.binding.sessionId,
                        hostPlatform: resolvePluginUiClientExecutablePlatform() ?? undefined,
                    }),
                }) : null;
            return Object.freeze({
                status: 'resolved' as const,
                action: current.action,
                policy: Object.freeze({
                    qualifiedId: invocation.qualifiedId,
                    occurrenceId: current.action.occurrenceId,
                    dangerLevel: current.action.dangerLevel,
                    scopes: current.action.scopes,
                    surfaces: current.action.surfaces,
                    ...(current.action.confirmation === undefined
                        ? {}
                        : { confirmation: current.action.confirmation }),
                    ...(current.action.confirmationWhen === undefined ? {} : { confirmationWhen: current.action.confirmationWhen }),
                    approvalRequiredByActionSettings: isApprovalRequiredByActionSettings(identity, invocationSurface, current.action, normalizedInput, invocationAuthority),
                    authorization: current.authorization,
                    ...(accountAvailability ? { availability: {
                        status: accountAvailability.outcome === 'hidden' ? 'unavailable' as const : accountAvailability.outcome,
                        code: accountAvailability.code,
                    } } : {}),
                    fingerprintContext: Object.freeze({
                        target: current.registration.target,
                        executionOrigin: current.registration.executionOrigin,
                        packageVersion: current.pluginVersion,
                    }),
                }),
                isCurrent: current.isCurrent,
            });
        },
        requestCurrentIntent,
    });
    const result = await preparedInput.invoke({
        ...(input.signal ? { signal: input.signal } : {}),
        preDispatch: async (handlerInput) => {
            normalizedInput = handlerInput.input;
            const admission = await presentUserGate.admit({
                input: handlerInput.input,
                surface: invocationSurface,
                invocationSurface,
                invocationAuthority,
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
            const currentUiContext = current.action.execution.target === 'account' ? undefined : readClientActionCurrentUiContext(current);
            const invokeHandler = (messageAction?: MessageActionAvailableSnapshotV1) => {
                if (signal.aborted || !current.isCurrent()) throw new PluginError({ code: 'plugin_action_generation_retired' });
                const accountOrigin = current.action.execution.target === 'account'
                    ? readPluginUiAccountExecutableOrigin(current.action) : null;
                const accountLifetime = current.registration.accountLifetime;
                if (current.action.execution.target === 'account' && (!accountOrigin || !accountLifetime)) {
                    throw new PluginError({ code: 'plugin_surface_account_action_unavailable' });
                }
                const accountCapability = accountOrigin && accountLifetime ? createPluginSurfaceAccountActionServices({
                    pluginId: current.action.pluginId, occurrenceId: current.registration.occurrenceId,
                    sourceCustody: accountOrigin.sourceCustody, accountLifetime, signal, isCurrent: current.isCurrent,
                    ...(input.contributedAction ? { machine: {
                        machineId: input.contributedAction.machineId,
                        serverId: input.contributedAction.serverId,
                    } } : {}),
                    execute: async (action, value, options) => {
                        let nestedInput: DispatchPluginSurfaceActionInput = {
                            callerPluginId: current.action.pluginId, callerSourceCustody: accountOrigin.sourceCustody,
                            action, input: value,
                            ...(input.hostAction ? { hostAction: input.hostAction } : {}),
                            ...(input.contributedAction ? { contributedAction: input.contributedAction } : {}),
                            ...(input.isContributedActionAvailable ? { isContributedActionAvailable: input.isContributedActionAvailable } : {}),
                            ...(input.settleContributedAction ? { settleContributedAction: input.settleContributedAction } : {}),
                            clientAction: current.binding, pluginUiProjection: input.pluginUiProjection,
                            resolveContributedAction: input.resolveContributedAction,
                            invocationSurface: 'plugin', originSurface, invocation: clientActionInvocation(current),
                            signal: options.signal,
                            ...(options.expectedContributorOccurrenceId === undefined ? {} : {
                                expectedContributorOccurrenceId: options.expectedContributorOccurrenceId,
                            }),
                            isCurrent: () => current.isCurrent() && options.isCurrent(),
                        };
                        const nestedIdentity = typeof action === 'string' && PluginInvocableActionIdSchema.safeParse(action).success
                            ? null : resolveContributedActionIdentity(nestedInput);
                        if (nestedIdentity && !nestedInput.contributedAction) {
                            const projected = resolveProjectedContributedAction(nestedInput, nestedIdentity);
                            const declaration = readPluginAccountAvailability(accountLifetime.scope).readCurrentAccountExecution(nestedIdentity.pluginId);
                            const selectedAction = projected ?? (declaration.kind === 'available'
                                ? declaration.manifest.contributes.actions?.find(candidate => candidate.id === nestedIdentity.localId) : null);
                            if (selectedAction?.execution.target === 'daemon') {
                                const readiness = await input.settleContributedAction?.(nestedIdentity, { signal: options.signal });
                                if (readiness?.ok === false) throw pluginActionDispatchFailureError(readiness);
                                if (readiness?.binding) nestedInput = { ...nestedInput, contributedAction: readiness.binding };
                                const currentProjected = resolveProjectedContributedAction(nestedInput, nestedIdentity);
                                if (projected && currentProjected && (currentProjected.execution.target !== 'daemon'
                                    || currentProjected.occurrenceId !== projected.occurrenceId)) {
                                    throw pluginActionDispatchFailureError(failure('stale_surface', 'plugin_ui_generation_retired'));
                                }
                                if (!nestedInput.contributedAction) throw createPluginActionHandlerNotStartedError({
                                    code: 'plugin_action_machine_required', message: 'This Action requires a selected online Machine',
                                });
                            }
                        }
                        const outcome = await dispatchPluginSurfaceAction(nestedInput);
                        if (!outcome.ok) throw pluginActionDispatchFailureError(outcome);
                        return outcome.result;
                    },
                }) : null;
                const clientCapability = accountCapability ? null : createClientActionUi(input, current, signal);
                const dispose = accountCapability?.dispose ?? clientCapability!.dispose;
                try {
                    const callerBinding = input.invocation?.kind === 'clientPluginAction' ? input.invocation.clientActionBinding : null;
                    const mountedCaller = resolveMountedPluginActionCaller(input);
                    const callerCustody = input.callerSourceCustody ?? callerBinding?.sourceCustody;
                    const caller = callerBinding && callerCustody ? {
                        kind: 'plugin' as const, pluginId: callerBinding.pluginId,
                        contribution: { id: callerBinding.contributionLocalId,
                            qualifiedId: `${callerBinding.pluginId}/${callerBinding.contributionLocalId}` },
                        occurrenceId: callerBinding.occurrenceId, sourceCustody: callerCustody,
                    } : mountedCaller && callerCustody ? {
                        kind: 'plugin' as const, pluginId: mountedCaller.pluginId,
                        contribution: { id: mountedCaller.contributionLocalId,
                            qualifiedId: `${mountedCaller.pluginId}/${mountedCaller.contributionLocalId}` },
                        occurrenceId: mountedCaller.occurrenceId, sourceCustody: callerCustody,
                        ...(mountedCaller.materialization ? { materialization: mountedCaller.materialization } : {}),
                    } : undefined;
                    const value = accountCapability
                        ? (current.handler as PluginAccountActionHandler)(actionInput, {
                            plugin: { id: current.action.pluginId, version: current.pluginVersion },
                            contribution: { id: current.action.id, qualifiedId: invocation.qualifiedId },
                            surface: invocationSurface, invokedAtMs: Date.now(), signal,
                            ...(caller ? { caller } : {}),
                            services: accountCapability.services,
                        })
                        : (current.handler as PluginClientActionHandler)(actionInput, {
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
                        ui: clientCapability!.ui,
                        ephemeralSharedScope: current.registration.occurrenceId
                            ? getPluginUiEphemeralSharedScope({
                                accountLifetime: current.registration.accountLifetime ?? null,
                                pluginId: current.action.pluginId,
                                occurrenceId: current.registration.occurrenceId,
                                executionOrigin: current.registration.executionOrigin,
                                isCurrent: () => current.isCurrent() && !signal.aborted,
                            })
                            : null,
                        ...(currentUiContext === undefined ? {} : { currentUiContext }),
                        ...(messageAction === undefined ? {} : { messageAction }),
                    });
                    // Preserve a synchronous known settlement at the canonical
                    // cancellation race instead of introducing an async hop.
                    if (value !== null && typeof value === 'object' && 'then' in value && typeof value.then === 'function') {
                        // Cleanup observes both branches without replacing the raw
                        // Promise whose settlement the canonical owner races.
                        void Promise.resolve(value).then(dispose, dispose);
                        return value;
                    }
                    dispose();
                    return value;
                } catch (error) {
                    dispose();
                    throw error;
                }
            };
            const reference = current.binding.messageActionReference;
            if (!reference) return invokeHandler();
            if (!('machineId' in authority)) throw new PluginError({ code: 'plugin_message_action_unavailable' });
            const messageInvocation = input.invocation?.kind === 'hostPresentedMessage' ? input.invocation
                : invocationSurface === 'cli' || invocationSurface === 'agent' || invocationSurface === 'mcp'
                    ? clientActionInvocation(current) : null;
            if (!messageInvocation) throw new PluginError({ code: 'plugin_message_action_unavailable' });
            // Reuse daemon Actions' exact current-row resolver after client
            // policy/confirmation, through the same strict Action RPC carrier.
            const execute = current.binding.execute ?? machinePluginStructuredMessageActionExecute;
            return execute(authority.machineId, {
                serverId: authority.serverId,
                expectedContributorOccurrenceId: current.action.occurrenceId,
                qualifiedActionId: buildQualifiedPluginContributionKey(identity),
                executionSurface: originSurface,
                invocation: messageInvocation,
                ...(current.binding.sessionId ? { sessionId: current.binding.sessionId } : {}),
                messageActionReference: reference,
                resolveClientMessageContext: true,
                ...(current.registration.accountLifetime ? { accountLifetime: current.registration.accountLifetime } : {}),
                signal, isCurrent: current.isCurrent,
            }).then((reply) => {
                const snapshot = reply.supported && reply.result.ok
                    ? MessageActionAvailableSnapshotV1Schema.safeParse(reply.result.result) : null;
                if (!snapshot?.success || snapshot.data.sessionId !== reference.sessionId
                    || snapshot.data.messageId !== reference.messageId
                    || snapshot.data.observedRevision !== reference.observedRevision) {
                    throw new PluginError({ code: 'plugin_message_action_unavailable' });
                }
                return invokeHandler(snapshot.data);
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
    const authorPayload = readPluginActionFailureAuthorPayload(result.data);
    return actionOutcomeUnknownFailure(result.code) ?? clientActionFailure(result.code, {
        message: result.message,
        ...(result.retryable === undefined ? {} : { retryable: result.retryable }),
        ...(authorPayload.remediation === undefined
            ? {}
            : { remediation: authorPayload.remediation }),
    });
}

type SubmittedSelectedActionInput = Extract<
    PluginUiSelectActionInputResultV1,
    Readonly<{ kind: 'submitted' }>
>;

/**
 * The settled selected-operation facts for one dispatch.
 *
 * `direct` is present when the dispatched Action is the selected operation's
 * own Action; `relay` is present when the bound target instead invokes one of
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
 * Bound-target ownership, direct-versus-relay authorization, the exact
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
    const clientCaller = input.invocation?.kind === 'clientPluginAction'
        && input.invocation.clientActionBinding.pluginId === input.callerPluginId
        ? input.invocation.clientActionBinding.pluginId
        : null;
    const callerPluginId = caller?.pluginId ?? clientCaller;
    if (
        !callerPluginId
        || input.selectedActionInput.selection.target.pluginId !== callerPluginId
        || !input.callerSourceCustody
        || !pluginSourceCustodyV1Equal(
            input.selectedActionInput.selection.target.sourceCustody,
            input.callerSourceCustody,
        )
        || (!directTargetedOperation && identity.pluginId !== callerPluginId)
    ) {
        // A selected settlement is anchored to the exact bound target. Its
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
        if (input.admissionOnly) return failure('invalid_payload', 'plugin_surface_admission_contributed_action_required');
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

    const clientCaller = input.invocation?.kind === 'clientPluginAction' ? input.invocation.clientActionBinding : null;

    const result = await binding.execute(actionId, input.input, mountedHostActionContext(input, caller, clientCaller, actionId));
    if (result.ok) return { ok: true, result: result.result as PluginUiJsonValueV1 };
    return failure('unavailable', result.errorCode);
}

/** Execution and Resource admission stamp exactly the same mounted caller. */
function mountedHostActionContext(input: DispatchPluginSurfaceActionInput, caller: MountedPluginActionCaller | null,
    clientCaller: Extract<NonNullable<DispatchPluginSurfaceActionInput['invocation']>, { kind: 'clientPluginAction' }>['clientActionBinding'] | null,
    actionId: ActionId): ActionExecutorContext {
    const sourceCustody = input.callerSourceCustody ?? caller?.mountedBinding.sourceCustody;
    const declarationBinding = caller?.mountedBinding ?? clientCaller;
    const { sessionListAccess, ...hostContext } = input.hostAction?.context ?? {};
    // A mounted read belongs to one invocation. Re-derive it at each entry;
    // a nested autonomous Action cannot retain its parent's UI read scope.
    const inheritedSessionListAccess = sessionListAccess === 'mounted_ui' ? undefined : sessionListAccess;
    return {
        ...hostContext,
        ...(inheritedSessionListAccess === undefined ? {} : { sessionListAccess: inheritedSessionListAccess }),
        // Admission belongs to the continued parent, not an Action it invokes.
        ...(clientCaller ? { bypassApprovals: false } : {}),
        ...(input.actionRequestId ? { actionRequestId: input.actionRequestId } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
        surface: 'plugin',
        // Borrowing the host's context never makes a Plugin the present user.
        // Keep its permission and input constraints while capping authority.
        authority: 'account_automation',
        // Only the actual mounted UI may browse its Account's Sessions. This
        // read scope does not grant human authority or flow into autonomous
        // client Action continuations, Voice, or a stricter inherited corpus.
        ...(actionId === 'session.list' && caller && !clientCaller && (input.invocationSurface ?? 'ui') === 'ui'
            && inheritedSessionListAccess === undefined
            ? { sessionListAccess: 'mounted_ui' as const }
            : {}),
        ...(caller || clientCaller
            ? {
                actionCaller: {
                    kind: 'plugin' as const,
                    pluginId: caller?.pluginId ?? clientCaller!.pluginId,
                    contributionLocalId: caller?.contributionLocalId ?? clientCaller!.contributionLocalId,
                    occurrenceId: caller?.occurrenceId ?? clientCaller!.occurrenceId,
                    ...(declarationBinding?.pluginVersion === undefined ? {} : { pluginVersion: declarationBinding.pluginVersion }),
                    ...(sourceCustody === undefined
                        ? {}
                        : { sourceCustody }),
                    ...((caller?.materialization ?? clientCaller?.materializationRef) === undefined
                        ? {}
                        : { materialization: caller?.materialization ?? clientCaller?.materializationRef }),
                },
            }
            : {}),
    };
}

/** Admit a borrowed host Resource without invoking the read effect. */
export async function preparePluginSurfaceHostRead(input: DispatchPluginSurfaceActionInput,
    actionId: ActionId): Promise<PluginSurfaceActionDispatchOutcome> {
    const stopped = preflightFailure(input);
    if (stopped) return stopped;
    const caller = resolveMountedPluginActionCaller(input);
    if (!caller) return failure('unavailable', 'plugin_mounted_caller_unavailable');
    const spec = getActionSpec(actionId);
    const context = mountedHostActionContext(input, caller, null, actionId);
    if (!spec.surfaces.plugin || !spec.pluginCallerPolicy
        || !isPluginActionCallerPolicySatisfied(spec.pluginCallerPolicy, input.input, context.actionCaller)) {
        return failure('unavailable', 'plugin_action_caller_forbidden');
    }
    const prepare = input.hostAction?.execute.prepare;
    if (!prepare) return failure('unavailable', 'action_prepare_unavailable');
    const prepared = await prepare(actionId, input.input, context);
    const late = preflightFailure(input);
    if (late) return late;
    if (prepared.kind === 'settled') return failure('unavailable', prepared.result.ok
        ? 'plugin_resource_admission_unavailable' : prepared.result.errorCode);
    return { ok: true, result: null };
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
        input.onPreInvocationMachineRefusal?.();
        return failure('unavailable', 'plugin_mounted_caller_unavailable');
    }
    if (caller && input.invocation) {
        return failure('invalid_payload', 'plugin_surface_action_invocation_ambiguous');
    }

    let projectedAction = resolveProjectedContributedAction(input, identity);
    // A retained declaration can precede the selected Machine's live projection
    // and binding. Wait at that daemon boundary, never by replaying its already
    // entered Account caller. The same resolver is read again after settlement.
    const declaredAction = projectedAction ?? input.resolveContributedAction?.(identity);
    if (!input.admissionOnly && declaredAction?.execution.target === 'daemon' && input.settleContributedAction) {
        const readiness = await input.settleContributedAction(identity, { signal: input.signal, requestId: input.actionRequestId });
        if (!readiness.ok) return readiness;
        const stopped = preflightFailure(input);
        if (stopped) return stopped;
        input = { ...input, contributedAction: readiness.binding };
        projectedAction = resolveProjectedContributedAction(input, identity);
        if (projectedAction && (projectedAction.execution.target !== 'daemon'
            || projectedAction.occurrenceId !== declaredAction.occurrenceId)) {
            return failure('stale_surface', 'plugin_ui_generation_retired');
        }
    }
    if (!projectedAction) {
        return failure('unavailable', 'plugin_surface_action_projection_unavailable');
    }
    if (!isContributedActionEnabled(identity, input.invocationSurface ?? 'ui')) {
        return failure('denied', 'plugin_action_disabled');
    }
    if (input.admissionOnly) {
        if (!projectedAction.surfaces.includes(input.invocationSurface ?? 'ui')) {
            return failure('denied', 'plugin_action_surface_unavailable');
        }
        const admitted = await settleDaemonActionPresentUserIntent(input, identity, projectedAction, input.input);
        if (!admitted.ok) return admitted;
        const stopped = preflightFailure(input);
        if (stopped) return stopped;
        if (resolveProjectedContributedAction(input, identity) !== projectedAction) {
            return failure('stale_surface', 'plugin_ui_generation_retired');
        }
        return { ok: true, result: { admitted: true } };
    }
    // Execution placement is chosen after the selected-operation carrier is
    // settled, so a client Action cannot bypass ownership, comparison, or
    // Connected-Account reconstruction that a daemon Action must satisfy.
    const settlement = settleSelectedTargetedOperation(input, identity, caller);
    if (!settlement.ok) return settlement;
    let clientPreparation: PreparedClientContributedAction | undefined;
    let normalizedInput = settlement.input;
    let daemonPreparedInput: Readonly<{ input: unknown }> | undefined;
    if (projectedAction.execution.target !== 'daemon') {
        const prepared = await prepareClientContributedAction(input, identity, projectedAction, settlement.input);
        if (!('kind' in prepared)) return prepared;
        clientPreparation = prepared;
        normalizedInput = prepared.preparedInput.input;
    } else {
        if (input.isContributedActionAvailable?.() === false) {
            input.onPreInvocationMachineRefusal?.();
            return failure('unavailable', 'plugin_surface_contributed_action_unavailable');
        }
        if (input.spokenActionRequest) {
            const binding = input.contributedAction;
            if (!binding) return clientActionFailure('plugin_surface_contributed_action_unavailable');
            const projectionScope = { machineId: binding.machineId, serverId: binding.serverId ?? null };
            const projectionRevision = getMachineContributionRegistryProjectionRevision(projectionScope);
            const schemas = await machinePluginActionSchemasRead(binding.machineId, { serverId: binding.serverId ?? null,
                expectedOccurrenceId: projectedAction.occurrenceId, qualifiedActionId: buildQualifiedPluginContributionKey(identity),
                ...(input.signal ? { signal: input.signal } : {}) });
            if (!schemas.supported || !schemas.result.ok) return schemas.supported && !schemas.result.ok
                ? staleDaemonProjectionFailure(schemas.result.code, projectionScope, projectionRevision, binding.accountLifetime)
                    ?? clientActionFailure('plugin_surface_action_schemas_unavailable')
                : clientActionFailure('plugin_surface_action_schemas_unavailable');
            const invocation = createPluginActionInvocation({ pluginId: identity.pluginId, localId: identity.localId,
                inputSchema: schemas.result.inputSchema, occurrenceSignal: input.signal ?? new AbortController().signal,
                isCurrent: () => input.isCurrent?.() !== false });
            const prepared = invocation.prepare(normalizedInput);
            if (prepared.kind === 'settled') return clientActionFailure('code' in prepared.result ? prepared.result.code : 'plugin_action_input_schema_invalid');
            normalizedInput = prepared.input;
            daemonPreparedInput = { input: normalizedInput };
        }
    }
    const runPrepared = async (input: DispatchPluginSurfaceActionInput): Promise<PluginSurfaceActionDispatchOutcome> => {
    if (projectedAction.execution.target !== 'daemon') {
        if (settlement.relay) {
            // The relay carrier is a daemon-request field. A client placement
            // has no channel for it, so the combination is refused at this one
            // owner instead of executing with the selection silently dropped.
            return failure('unsupported_method', 'plugin_surface_targeted_selection_relay_unsupported');
        }
        return executeClientContributedAction(input, identity, projectedAction, clientPreparation!);
    }

    if (input.isContributedActionAvailable?.() === false) {
        input.onPreInvocationMachineRefusal?.();
        return failure('unavailable', 'plugin_surface_contributed_action_unavailable');
    }
    const binding = input.contributedAction;
    if (!binding) {
        input.onPreInvocationMachineRefusal?.();
        return failure('unavailable', 'plugin_surface_contributed_action_unavailable');
    }
    if (caller?.materialization && caller.materialization.machineId !== binding.machineId) {
        return failure('unavailable', 'plugin_mounted_caller_unavailable');
    }

    const presentUserIntent = await settleDaemonActionPresentUserIntent(input, identity, projectedAction, normalizedInput, daemonPreparedInput);
    if (!presentUserIntent.ok) return presentUserIntent;
    const currentFailure = preflightFailure(input);
    if (currentFailure) return currentFailure;
    if (input.isContributedActionAvailable?.() === false) {
        return failure('unavailable', 'plugin_surface_contributed_action_unavailable');
    }
    if (binding.accountLifetime !== undefined && binding.accountLifetime?.isCurrent() !== true) {
        return failure('stale_surface', 'plugin_ui_generation_retired');
    }

    const originSurface = readActionOriginSurface(input);
    if (!originSurface) return failure('unavailable', 'plugin_action_origin_unavailable');
    const execute = binding.execute ?? machinePluginStructuredMessageActionExecute;
    // The admitted projection owns whether this invocation can produce a daemon
    // operation at all; a declaration-free Action still carries no request id.
    const admittedOperation = projectedAction.operation;
    const admittedRequestId = admittedOperation ? input.actionRequestId : undefined;
    if (admittedOperation && admittedRequestId) {
        input.onDaemonActionOperationAdmitted?.(admittedOperation);
    }
    const actionInput = normalizedInput;
    const projectionScope = {
        machineId: binding.machineId,
        serverId: binding.accountLifetime?.scope.serverId ?? binding.serverId ?? null,
    };
    const projectionRevision = getMachineContributionRegistryProjectionRevision(projectionScope);
    const result = await execute(binding.machineId, {
        serverId: binding.serverId ?? null,
        ...(binding.accountLifetime === undefined ? {} : { accountLifetime: binding.accountLifetime }),
        isCurrent: () => input.isCurrent?.() !== false && input.isContributedActionAvailable?.() !== false,
        expectedContributorOccurrenceId: projectedAction.occurrenceId,
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
        executionSurface: originSurface,
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
        ...(settlement.relay
            ? { selectedActionInputCarrier: settlement.relay }
            : {}),
        ...(presentUserIntent.presentUserIntent
            ? { presentUserIntent: presentUserIntent.presentUserIntent }
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
    return staleDaemonProjectionFailure(result.result.code, projectionScope, projectionRevision, binding.accountLifetime)
        ?? actionDeclinedFailure(result.result.code)
        ?? failure('unavailable', result.result.code, {
            ...(result.result.message === undefined ? {} : { message: result.result.message }),
            ...(result.result.retryable === undefined
                ? {}
                : { retryable: result.result.retryable }),
            ...(result.result.remediation === undefined
                ? {}
                : { remediation: result.result.remediation }),
        });
    };
    if (input.spokenActionRequest && (input.invocationSurface ?? 'ui') === 'voice') {
        return executePreparedPluginSurfaceAction({ input, identity, action: projectedAction,
            normalizedInput, run: runPrepared });
    }
    return runPrepared(input);
}

export type CreatePluginSurfaceActionDispatchHandlerInput = Readonly<{
    pluginId: string;
    /** The existing physical controller lifetime cancels pending mounted Actions as well as reads. */
    lifetimeSignal?: AbortSignal;
    /** Exact mounted-target custody when this handler can settle a targeted operation. */
    callerSourceCustody?: PluginSourceCustodyV1;
    /** Exact declaring contribution from the bound mount's validated context. */
    contributionId?: string;
    callerBinding?: PluginSurfaceActionMountedBinding;
    hostAction?: PluginSurfaceHostActionBinding;
    contributedAction?: PluginSurfaceContributedActionBinding;
    clientAction?: PluginSurfaceClientActionBinding;
    /** The mount's own confirmation presenter, used for both placements. */
    requestCurrentIntent?: PluginSurfaceActionCurrentIntentPresenter;
    invocationSurface?: PluginSurfaceActionInvocationSurface;
    resolveContributedAction?: PluginSurfaceContributedActionDescriptorResolver;
    isContributedActionAvailable?: () => boolean;
    settleContributedAction?: PluginSurfaceContributedActionSettlement;
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

        const cancellation = mergeAbortSignals([input.lifetimeSignal, options?.signal]);
        let connectionPendingEligible = false;
        const outcome = await dispatchPluginSurfaceAction({
            actionRequestId: request.requestId,
            callerPluginId: input.pluginId,
            callerSourceCustody: input.callerSourceCustody,
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
            ...(input.requestCurrentIntent ? { requestCurrentIntent: input.requestCurrentIntent } : {}),
            ...(input.invocationSurface ? { invocationSurface: input.invocationSurface } : {}),
            ...(input.resolveContributedAction
                ? { resolveContributedAction: input.resolveContributedAction }
                : {}),
            ...(input.isContributedActionAvailable
                ? { isContributedActionAvailable: input.isContributedActionAvailable }
                : {}),
            ...(input.settleContributedAction ? { settleContributedAction: input.settleContributedAction } : {}),
            onPreInvocationMachineRefusal: () => { connectionPendingEligible = true; },
            ...(cancellation.signal ? { signal: cancellation.signal } : {}),
            ...(targetedOperation ? { targetedOperation } : {}),
            ...(selectedActionInput ? { selectedActionInput } : {}),
            ...(input.isCurrent ? { isCurrent: input.isCurrent } : {}),
        }).finally(cancellation.dispose);
        if (!outcome.ok) return createPluginSurfaceHostApiError(outcome.code, [outcome.reason], outcome.message, { connectionPendingEligible });
        return outcome.result;
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
/** Committed optional Machine services; requester and Account lifetimes stay with the facade. */
export type PluginSurfaceMachineHostApiBindings = Readonly<{
    /** Existing selected routing, known even before its executable occurrence arrives. */
    executionTarget?: Readonly<{ machineId: string; serverId: string | null }>;
    contributedAction?: PluginSurfaceContributedActionBinding;
    resource?: PluginSurfaceResourceBinding;
    allowPluginResources?: boolean;
    admissionMethods?: readonly PluginUiHostMethodV1[];
    selectActionInput?: PluginSurfaceHostApiMethodHandler;
    createOpenNewSession?: (executeSelectedOperation: PluginSurfaceHostApiMethodHandler) => PluginSurfaceHostApiMethodHandler;
}>;

export function createPluginSurfaceActionHostApi(input: Readonly<{
    surfaceContext: PluginUiSurfaceContextV1;
    /** Structural support projected by the canonical bound controller. */
    admissionMethods?: readonly PluginUiHostMethodV1[];
    /** Exact mounted-target custody supplied by the target-scoped projection owner. */
    callerSourceCustody?: PluginSourceCustodyV1;
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
    /** Dedicated mounted New Session producer, composed over this exact dispatcher. */
    createOpenNewSession?: (
        executeSelectedOperation: PluginSurfaceHostApiMethodHandler,
    ) => PluginSurfaceHostApiMethodHandler;
    /**
     * The daemon binding for the resource snapshot authority (§3.6). Present
     * only when the mount can address a machine and a projected generation, so
     * `readResource` is installed — and therefore advertised — exactly where it
     * can actually be served.
     */
    resource?: PluginSurfaceResourceBinding;
    /** Borrowed Account read entries, after this exact mounted caller's Action admission. */
    hostResourceStore?: PluginUiResourceStore;
    /** The bound controller's existing mount lifetime for Resource work and mounted Actions. */
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
        /** Host reads can watch without widening a static plugin Resource's ceiling. */
        allowPluginResources?: boolean;
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
    /** Context stays with the bound controller; error provenance stays with the facade. */
    resolveUnavailableError?: (error: PluginUiHostApiErrorPayloadV1, request: PluginUiHostApiRequestEnvelopeV1) => PluginUiHostApiErrorPayloadV1 | undefined;
    isConnectionPending?: (error: PluginUiHostApiErrorPayloadV1, request: PluginUiHostApiRequestEnvelopeV1) => boolean;
    /** Live controller capability for the daemon branch of `executeAction`. */
    isContributedActionAvailable?: () => boolean;
    /**
     * Exact host-owned semantics for this physical mount. These supplement the
     * canonical facade; they never replace Action, Resource, or local handlers.
     */
    mountedHostApiHandlers?: PluginSurfaceHostApiHandlers;
    readMountedHostApiHandlers?: () => PluginSurfaceHostApiHandlers;
    /** Updated only by the bound controller's existing committed binding owner. */
    readMachineBindings?: () => PluginSurfaceMachineHostApiBindings;
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
            ...(input.admissionMethods ? { admissionMethods: input.admissionMethods } : {}),
            ...(input.isMethodAvailable ? { isMethodAvailable: input.isMethodAvailable } : {}),
            ...(input.resolveUnavailableError ? { resolveUnavailableError: input.resolveUnavailableError } : {}),
            ...(input.isConnectionPending ? { isConnectionPending: input.isConnectionPending } : {}),
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
    let hostAdmissionCurrent = true;
    const feedback = createPluginSurfaceFeedbackHandlers({
        pluginUiProjection: input.pluginUiProjection,
        surfaceId: input.surfaceContext.surfaceId,
        resolveActionPolicy: (reference) => {
            const identity = normalizePluginUiMountedContributedActionReferenceV1({
                callerPluginId: input.surfaceContext.pluginId,
                action: reference,
            });
            if (!identity) return null;
            // Direct Account writes need declaration/policy, not a daemon handler.
            const action = input.resolveContributedAction?.(identity);
            if (!action || action.pluginId !== identity.pluginId || action.id !== identity.localId) return null;
            const surface = input.invocationSurface ?? 'ui';
            return {
                enabled: action.available === true && action.surfaces.includes(surface) && isContributedActionEnabled(identity, surface),
                approvalRequired: isApprovalRequiredByActionSettings(identity, surface, action),
            };
        },
        ...(input.interactionRequester ? { interactionRequester: input.interactionRequester } : {}),
        ...(input.isCurrent ? { isCurrent: input.isCurrent } : {}),
    });
    let machineBindings: PluginSurfaceMachineHostApiBindings = input.readMachineBindings?.() ?? {
        ...(input.contributedAction ? { executionTarget: { machineId: input.contributedAction.machineId,
            serverId: input.contributedAction.serverId ?? null } } : {}),
        contributedAction: input.contributedAction, resource: input.resource,
        allowPluginResources: input.resourceInvalidation?.allowPluginResources,
        admissionMethods: input.admissionMethods, selectActionInput: input.selectActionInput,
        createOpenNewSession: input.createOpenNewSession,
    };
    const resourceWatch = (machineBindings.resource || input.hostResourceStore || input.readMachineBindings) && input.resourceInvalidation
        ? createPluginSurfaceResourceWatchHandlers({
            pluginId: input.surfaceContext.pluginId,
            ...(machineBindings.resource && machineBindings.allowPluginResources !== false ? { resource: machineBindings.resource } : {}),
            ...(input.hostResourceStore ? { hostResourceStore: input.hostResourceStore } : {}),
            ...(input.isContributedActionAvailable ? { isDaemonAvailable: input.isContributedActionAvailable } : {}),
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
    const readMountedHandlers = () => input.readMountedHostApiHandlers?.() ?? input.mountedHostApiHandlers ?? {};
    const mountedDisposeHostResource: PluginSurfaceHostApiMethodHandler = (request, options) =>
        readMountedHandlers().disposeHostResource?.(request, options) ?? null;
    const resourceDisposeHostResource = resourceWatch?.disposeHostResource;
    const createExecuteAction = (machine: PluginSurfaceMachineHostApiBindings) => createPluginSurfaceActionDispatchHandler({
        pluginId: input.surfaceContext.pluginId,
        ...(input.resourceLifetimeSignal ? { lifetimeSignal: input.resourceLifetimeSignal } : {}),
        ...(input.callerSourceCustody
            ? { callerSourceCustody: input.callerSourceCustody }
            : {}),
        contributionId: input.surfaceContext.contributionId,
        ...(input.callerBinding ? { callerBinding: input.callerBinding } : {}),
        ...(input.hostAction ? { hostAction: input.hostAction } : {}),
        ...(machine.contributedAction ? { contributedAction: machine.contributedAction } : {}),
        ...(input.clientAction
            ? {
                clientAction: {
                    ...input.clientAction,
                    ...(input.openSurface ? { openSurface: input.openSurface } : {}),
                },
            }
            : {}),
        // The mount's confirmation presenter serves both execution placements.
        ...(feedback.requestCurrentIntent
            ? { requestCurrentIntent: feedback.requestCurrentIntent }
            : {}),
        ...(input.invocationSurface ? { invocationSurface: input.invocationSurface } : {}),
        ...(input.resolveContributedAction
            ? { resolveContributedAction: input.resolveContributedAction }
            : {}),
        ...(input.isContributedActionAvailable
            ? { isContributedActionAvailable: input.isContributedActionAvailable }
            : {}),
        settleContributedAction: async (identity, options) => {
            const requestedTarget = machine.executionTarget;
            const request: PluginUiHostApiRequestEnvelopeV1 = { version: 1,
                requestId: options.requestId ?? 'nested-action-admission', surface: input.surfaceContext,
                method: 'executeAction', payload: { action: identity } };
            await hostApi.waitForConnectionSettlement?.({ code: 'unavailable',
                diagnostics: ['plugin_surface_contributed_action_unavailable'] }, request, { signal: options.signal });
            if (options.signal?.aborted) return failure('unavailable', 'plugin_ui_invocation_aborted');
            if (!hostAdmissionCurrent || input.isCurrent?.() === false) return failure('stale_surface', 'plugin_ui_generation_retired');
            refreshMachineBindings();
            const currentTarget = machineBindings.executionTarget;
            if (requestedTarget && (!currentTarget || requestedTarget.machineId !== currentTarget.machineId
                || (requestedTarget.serverId !== null && (currentTarget.serverId === null
                    || !areServerProfileIdentifiersEquivalent(requestedTarget.serverId, currentTarget.serverId))))) {
                return failure('stale_surface', 'plugin_ui_generation_retired');
            }
            // A selected Machine which finished admission with a genuine
            // outage is not an absent selection. Preserve its canonical
            // unavailable diagnostic so the facade can publish the target
            // owner's classified failure, even before a binding ever arrived.
            if (currentTarget && input.isContributedActionAvailable?.() === false) {
                return failure('unavailable', 'plugin_surface_contributed_action_unavailable');
            }
            return { ok: true, binding: machineBindings.contributedAction };
        },
        ...(input.isCurrent ? { isCurrent: input.isCurrent } : {}),
    });
    let executeCurrentAction = createExecuteAction(machineBindings);
    const executeAction: PluginSurfaceHostApiMethodHandler = (request, options) => executeCurrentAction(request, options);
    const createMachineHandlers = (machine: PluginSurfaceMachineHostApiBindings): PluginSurfaceHostApiHandlers => ({
        ...(machine.resource || input.hostResourceStore ? { readResource: createPluginSurfaceResourceReadHandler({
            pluginId: input.surfaceContext.pluginId,
            ...(machine.resource ? { resource: machine.resource } : {}),
            ...(input.hostResourceStore ? { hostResourceStore: input.hostResourceStore } : {}),
            ...(input.isContributedActionAvailable ? { isDaemonAvailable: input.isContributedActionAvailable } : {}),
            ...(input.resourceLifetimeSignal ? { lifetimeSignal: input.resourceLifetimeSignal } : {}),
            ...(input.isCurrent ? { isCurrent: input.isCurrent } : {}),
        }) } : {}),
        ...(resourceWatch && ((machine.resource && machine.allowPluginResources !== false) || input.hostResourceStore)
            ? { watchResource: resourceWatch.watchResource } : {}),
        ...(machine.selectActionInput ? { selectActionInput: machine.selectActionInput } : {}),
        ...(machine.createOpenNewSession ? { openNewSession: machine.createOpenNewSession(executeAction) } : {}),
    });
    let machineHandlers = createMachineHandlers(machineBindings);
    const refreshMachineBindings = () => {
        const next = input.readMachineBindings?.();
        if (!next || next === machineBindings) return;
        machineBindings = next;
        resourceWatch?.updateResource(next.allowPluginResources !== false ? next.resource : undefined);
        executeCurrentAction = createExecuteAction(next);
        machineHandlers = createMachineHandlers(next);
    };
    const hostApiInput: Parameters<typeof createPluginSurfaceHostApi>[0] = {
        surfaceContext: input.surfaceContext,
        ...(input.admissionMethods ? { admissionMethods: input.admissionMethods } : {}),
        ...(input.isMethodAvailable ? { isMethodAvailable: input.isMethodAvailable } : {}),
        ...(input.resolveUnavailableError ? { resolveUnavailableError: input.resolveUnavailableError } : {}),
        ...(input.isConnectionPending ? { isConnectionPending: input.isConnectionPending } : {}),
        ...(input.isCurrent ? { isCurrent: input.isCurrent } : {}),
        handlers: {
            ...localHostHandlers,
            executeAction,
            admitAction: async (request, options) => {
                const contributedAction = machineBindings.contributedAction;
                const payload = PluginUiExecuteActionRequestV1Schema.safeParse(request.payload);
                if (!payload.success) return createPluginSurfaceHostApiError('invalid_payload');
                const cancellation = mergeAbortSignals([input.resourceLifetimeSignal, options?.signal]);
                try {
                    const outcome = await dispatchPluginSurfaceAction({
                        admissionOnly: true,
                        callerPluginId: input.surfaceContext.pluginId,
                        ...(input.hostAction ? { hostAction: input.hostAction } : {}),
                        ...(contributedAction ? { contributedAction } : {}),
                        ...(input.callerSourceCustody ? { callerSourceCustody: input.callerSourceCustody } : {}),
                        ...(input.callerBinding ? {
                            callerContributionLocalId: input.surfaceContext.contributionId,
                            callerBinding: input.callerBinding,
                        } : {}),
                        action: payload.data.action,
                        ...(payload.data.input === undefined ? {} : { input: payload.data.input }),
                        ...(input.resolveContributedAction ? { resolveContributedAction: input.resolveContributedAction } : {}),
                        ...(feedback.requestCurrentIntent ? { requestCurrentIntent: feedback.requestCurrentIntent } : {}),
                        ...(input.invocationSurface ? { invocationSurface: input.invocationSurface } : {}),
                        ...(cancellation.signal ? { signal: cancellation.signal } : {}),
                        isCurrent: () => input.isCurrent?.() !== false && hostAdmissionCurrent,
                    });
                    if (outcome.ok) return outcome.result;
                    if (outcome.reason === PLUGIN_ACTION_CURRENT_INTENT_REJECTED_CODE) return { admitted: false };
                    return createPluginSurfaceHostApiError(outcome.code, [outcome.reason]);
                } finally {
                    cancellation.dispose();
                }
            },
            notify: feedback.notify,
            confirm: feedback.confirm,
            ...(input.openSurface
                ? {
                    openSurface: createPluginSurfaceOpenSurfaceHandler(
                        input.openSurface,
                        input.isCurrent,
                    ),
                }
                : {}),
        },
        onDispose: () => {
            hostAdmissionCurrent = false;
            resourceWatch?.dispose();
            feedback.dispose();
            input.disposeMountedHostApiHandlers?.();
        },
    };
    const disposeHostResource: PluginSurfaceHostApiMethodHandler = async (request, options) => {
        const mountedResult = await mountedDisposeHostResource(request, options);
        const resourceResult = resourceDisposeHostResource ? await resourceDisposeHostResource(request) : null;
        return resourceResult ?? mountedResult;
    };
    const hostApi = createPluginSurfaceHostApi({ ...hostApiInput,
        get admissionMethods() { refreshMachineBindings(); return machineBindings.admissionMethods; },
        readHandlers: () => {
            refreshMachineBindings();
            const mounted = readMountedHandlers();
            return { ...mounted, ...hostApiInput.handlers, ...machineHandlers,
                ...(resourceDisposeHostResource || mounted.disposeHostResource ? { disposeHostResource } : {}),
            };
        },
    });
    return hostApi;
}
