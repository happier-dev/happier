import { projectActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { readPluginModuleFailureCause } from '@/plugins/runtime/moduleFailure';
import { ACTION_IDS } from '@happier-dev/protocol/actions/actionIds';
import { resolvePluginLocalizedStringV2Text } from '@happier-dev/protocol/plugins/contributions/public-types';
import { formatQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import { parseQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { ACCOUNT_PLUGIN_CENSUS_UNAVAILABLE_MESSAGE } from '@/plugins/projection/registry/builtIn/enablement';
import type { ActionExecutorContext, ActionId, QualifiedPluginActionId } from '@happier-dev/protocol/actions';
import { buildApprovalExecutionOriginV1, isHostAdmittedReviewedChildPolicyV1, readHostReviewedChildOperationV1, type HostReviewedChildPortV1 } from '@happier-dev/protocol/actions/actionExecutor';
import { actionInputIssueFailure } from '@happier-dev/protocol/actions/executor/actionInputValidation';
import { randomUUID } from 'node:crypto';
import { AgentRuntimeJsonValueV1Schema } from '@happier-dev/protocol/runtime/agentSessionV1';
import type { HostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import type { RpcHandlerContext } from '@/api/rpc/types';
import { runTracedExternalActionStage } from '@/daemon/externalActions/externalActionPhase';
import { pluginActionRequiresPresentUserIntent, pluginActionDeclarationRequiresConfirmationForInput, readPluginActionFailureAuthorPayload } from '@happier-dev/protocol/plugins/actions/invocation';
import { APPROVAL_REQUESTER_UNAVAILABLE_MESSAGE_V1, resolveApprovalRequesterConfirmationV1 } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { projectTargetActionApprovalInput } from '@happier-dev/protocol/actions/actionApprovalPresentation';
import type { ActionsSettingsV1, ApprovalExecutionOriginV1, JsonValue, MessageActionAvailableSnapshotV1, MessageActionReferenceV1, PluginMachineExecutionOriginV1, RehydratedPluginContributionPointOperationV1, TargetActionApprovalReplayPlacementV1, UiContributedActionExecuteRequestV1 } from '@happier-dev/protocol';
import { UiContributedActionExecuteRequestV1Schema } from '@happier-dev/protocol/plugins/actions/clientInvocationV1';
import { arePluginMachineExecutionOriginsEqual, getPluginMachineExecutionOriginRef, arePluginMachineExecutionRoutingsEqual, getPluginMachineExecutionRouting } from '@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1';
import type { PluginMachineExecutionRoutingV1 } from '@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1';
import type { PluginUiSelectedActionInputCarrierV1 } from '@happier-dev/protocol/plugins/ui';
import type {
  PluginInvocationCaller,
  PluginInvocationOriginSurface,
} from '@happier-dev/plugin-sdk';
import { PluginError } from '@happier-dev/plugin-sdk';
import { validateTargetedOperationInput, validateTargetedOperationResult } from '@happier-dev/cli-common/plugins/registration';
import type { PluginActionHandlerInvocation } from '@happier-dev/plugin-sdk/actions';

import type {
  ResolvedActionContribution,
  ResolvedContributionRegistry,
} from '@/plugins/projection/registry/types';
import { projectPluginFailureText } from '@/plugins/runtime/lifecycle/utils';
import { contributedActionFailureResult } from './contributedActionFailure';
import type { PluginActionSurface } from '@/plugins/runtime/types';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import type { ContributionPolicyFacts } from '@/plugins/runtime/policy/evaluate';
import type { TargetActionCurrentIntentRequest, TargetActionCurrentIntentResult } from '@/plugins/runtime/invocation/actionExecutor';
import type { TargetActionOperationProgressPort } from '@/plugins/runtime/invocation/targetActionRegistry';
import type { PluginExternalActionContext } from '@/plugins/runtime/invocation/services/types';
import { isActionEnabledByActionsSettings } from '@happier-dev/protocol/actions/actionSettings';
import { resolveProfiledActionsSettingsV1 } from '@happier-dev/protocol/actions/approvalProfiles';
import { isSharedRequesterActionV1, readExplicitActionApprovalPreferenceV1, resolveActionApprovalRouting } from '@happier-dev/protocol/actions/actionApprovalPolicy';
import { isHomeAdmittedPresentUserHostInvocation, isPresentUserHostInvocation } from '@happier-dev/protocol/actions/invocationAuthority';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { readInstallationIdentityIfExistsSync } from '@/daemon/identity/store';
import { decodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { isOriginalOwnAccountActionCustody } from '@/daemon/sessionEncryption/requesterAccountActionProjection';
import { readRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionContext';
import { parseActionSurfaceKey } from '@happier-dev/protocol/actions/executor/callerContext';
import { readActionPrincipalAccountId } from '@/session/actions/actionPrincipalAccount';
import { checkManagedProviderOperationCustody, isAdmittedManagedProviderCustodyCurrent, type AdmittedManagedProviderOperationExecutionRequest,
  type AdmittedConnectedAccountPurposeBindingExecutionRequest } from './managedProviderCustody';
export type { AdmittedManagedProviderOperationExecutionRequest, AdmittedConnectedAccountPurposeBindingExecutionRequest } from './managedProviderCustody';

export type PluginActionExecutorResult = Pick<import('@happier-dev/protocol/actions/actionExecutionResult').ActionExecuteResult, 'automationNotices'> & Readonly<
  | {
    ok: true;
    result: JsonValue | null;
    /** Host-private handoff from current-intent admission to Action ingress. */
    deferredApprovalArtifactId?: string;
    /** Present only for the contributed-Action execution-origin request. */
    executionOrigin?: PluginMachineExecutionOriginV1;
  }
  | {
    ok: false;
    errorCode: string;
    error: string;
    /** Canonical host Action details, projected by their owning producer. */
    details?: unknown;
    /** Present only for a proven canonical PluginError from the target handler. */
    retryable?: boolean;
    /** The target's own published PluginError contract payload. */
    data?: JsonValue;
    /** Present only when the target Action handler did not begin. */
    actionHandlerInvocation?: PluginActionHandlerInvocation;
  }
>;

export type PluginActionExecutionAttempt = Readonly<
  | { matched: false }
  | { matched: true; result: PluginActionExecutorResult }
>;

export type ClientContributedActionExecutor = (
  request: UiContributedActionExecuteRequestV1,
  options: Readonly<{ signal?: AbortSignal; clientId?: string; principalAccountId?: string }>,
) => Promise<PluginActionExecutorResult>;

type PluginActionExecutionRegistry = ResolvedContributionRegistry | ResolvedExecutablePluginRuntimeRegistry;

/**
 * Host-private evidence carried only from one original admitted targeted
 * operation handle to the canonical contributed-Action dispatcher.
 */
export type AdmittedTargetedOperationExecutionRequest = Readonly<{
  action: Readonly<{
    pluginId: string;
    localId: string;
  }>;
  target: Readonly<{
    pluginId: string;
    occurrenceId: string;
  }>;
  contributorOccurrenceId: string;
  targetProtocol: RehydratedPluginContributionPointOperationV1;
}>;

type CurrentTargetExecutionOrigin = Readonly<
  | { status: 'resolved'; origin: PluginMachineExecutionOriginV1 }
  | { status: 'aborted' | 'unavailable' }
>;

type CurrentTargetApprovalReplayPlacement = Readonly<
  | { status: 'resolved'; placement: NonNullable<Awaited<ReturnType<NonNullable<
      ResolvedExecutablePluginRuntimeRegistry['resolveCurrentPluginApprovalReplayPlacement']>>>> }
  | { status: 'aborted' | 'unavailable' }
>;

const BUILT_IN_ACTION_IDS = new Set<string>(ACTION_IDS);

function isBuiltInActionId(actionId: string): boolean {
  return BUILT_IN_ACTION_IDS.has(actionId);
}

function resolveContributedActionSettingsId(
  pluginId: string,
  localId: string,
): QualifiedPluginActionId | null {
  try {
    return formatQualifiedPluginActionId({ pluginId, localId });
  } catch {
    // Published contributed Actions already satisfy the canonical contribution
    // identity contract. Legacy in-memory test fixtures without that identity
    // remain outside the settings namespace rather than acquiring an alias.
    return null;
  }
}

function isExecutablePluginRuntimeRegistry(
  registry: PluginActionExecutionRegistry,
): registry is ResolvedExecutablePluginRuntimeRegistry {
  return 'contributes' in registry;
}

function readContributionRegistry(registry: PluginActionExecutionRegistry): ResolvedContributionRegistry {
  return isExecutablePluginRuntimeRegistry(registry) ? registry.contributes : registry;
}

async function resolveCurrentTargetExecutionOrigin(
  registry: ResolvedExecutablePluginRuntimeRegistry,
  pluginId: string,
  signal: AbortSignal | undefined,
): Promise<CurrentTargetExecutionOrigin> {
  if (signal?.aborted) return Object.freeze({ status: 'aborted' as const });
  const resolver = registry.resolveCurrentPluginExecutionOrigin;
  if (!resolver) return Object.freeze({ status: 'unavailable' as const });
  try {
    const origin = await resolver(pluginId, signal);
    if (signal?.aborted) return Object.freeze({ status: 'aborted' as const });
    if (!origin || getPluginMachineExecutionOriginRef(origin).pluginId !== pluginId) {
      return Object.freeze({ status: 'unavailable' as const });
    }
    return Object.freeze({ status: 'resolved' as const, origin });
  } catch {
    return Object.freeze({
      status: signal?.aborted ? 'aborted' as const : 'unavailable' as const,
    });
  }
}

async function resolveCurrentTargetApprovalReplayPlacement(
  registry: ResolvedExecutablePluginRuntimeRegistry,
  pluginId: string,
  signal: AbortSignal | undefined,
): Promise<CurrentTargetApprovalReplayPlacement> {
  if (signal?.aborted) return Object.freeze({ status: 'aborted' as const });
  const resolver = registry.resolveCurrentPluginApprovalReplayPlacement;
  if (!resolver) return Object.freeze({ status: 'unavailable' as const });
  try {
    const placement = await resolver(pluginId, signal);
    if (signal?.aborted) return Object.freeze({ status: 'aborted' as const });
    if (!placement) return Object.freeze({ status: 'unavailable' as const });
    return Object.freeze({ status: 'resolved' as const, placement });
  } catch {
    return Object.freeze({
      status: signal?.aborted ? 'aborted' as const : 'unavailable' as const,
    });
  }
}

/**
 * A targeted-contribution admission binds the contributor's exact process-local
 * occurrence. That identity exists before demand activation, unlike
 * a real runtime materialization. When the admitted execution context has a
 * real materialization too, it remains an additional post-activation fence;
 * no caller may synthesize one for a cold bundled contributor.
 */
async function isExpectedPluginCurrent(params: Readonly<{
  runtimeRegistry: ResolvedExecutablePluginRuntimeRegistry | null;
  pluginId: string;
  expectedOccurrenceId: string;
  expectedMaterializationId?: string;
  requireMaterialization: boolean;
}>): Promise<boolean> {
  if (!params.runtimeRegistry) return false;
  try {
    const currentOccurrenceId = params.runtimeRegistry.readPluginOccurrenceId?.(params.pluginId);
    if (currentOccurrenceId !== params.expectedOccurrenceId) {
      return false;
    }
    if (!params.requireMaterialization || params.expectedMaterializationId === undefined) {
      return true;
    }
    const currentMaterialization = params.runtimeRegistry
      .resolveCurrentPluginMaterializationRef?.(params.pluginId);
    return currentMaterialization?.pluginId === params.pluginId
      && currentMaterialization.materializationId === params.expectedMaterializationId;
  } catch {
    return false;
  }
}

function actionHandlerNotStartedFailure(
  errorCode: string,
  error: string,
  cause?: unknown,
): Extract<PluginActionExecutorResult, { ok: false }> {
  return {
    ok: false,
    errorCode,
    error,
    ...(cause === undefined ? {} : { data: { failureCause: projectActionFailureCauseV1(cause, 'plugin.activation') } }),
    actionHandlerInvocation: 'notStarted',
  };
}

/** Read the same deliberate enabled preference before planning an admitted role. */
export function checkContributedActionSettingsAvailability(params: Readonly<{
  action: ResolvedActionContribution;
  surface: NonNullable<import('@happier-dev/protocol/actions/actionSettings').ActionEnablementContext['surface']>;
  actionsSettings?: ActionsSettingsV1;
}>): Extract<PluginActionExecutorResult, { ok: false }> | null {
  const pluginId = params.action.pluginId;
  const settingsId = pluginId ? resolveContributedActionSettingsId(pluginId, params.action.definition.id) : null;
  if (settingsId !== null && !isActionEnabledByActionsSettings(settingsId,
    params.actionsSettings ?? createActionSettingsProvider().getActionsSettings(), { surface: params.surface })) {
    return actionHandlerNotStartedFailure('plugin_action_unavailable', 'Plugin action is disabled by Action settings');
  }
  return null;
}

function admittedContributorOccurrenceRetired(): PluginActionExecutorResult {
  return actionHandlerNotStartedFailure(
    'plugin_action_generation_retired',
    'Admitted contributor occurrence is no longer current',
  );
}

function admittedTargetOccurrenceRetired(): PluginActionExecutorResult {
  return actionHandlerNotStartedFailure(
    'plugin_action_generation_retired',
    'Admitted target occurrence is no longer current',
  );
}

function admittedTargetedOperationInvalid(): PluginActionExecutorResult {
  return actionHandlerNotStartedFailure(
    'plugin_admitted_targeted_operation_handle_invalid',
    'Admitted targeted operation binding is invalid',
  );
}


function matchesAdmittedTargetedOperation(
  operation: AdmittedTargetedOperationExecutionRequest,
  action: ResolvedActionContribution,
  caller: PluginInvocationCaller | undefined,
): boolean {
  return operation.action.pluginId === action.pluginId
    && operation.action.localId === action.definition.id
    && caller?.kind === 'plugin'
    && caller.pluginId === operation.target.pluginId;
}

async function activateOwningPluginForAction(params: Readonly<{
  registry: PluginActionExecutionRegistry;
  contributes: ResolvedContributionRegistry;
  action: ResolvedActionContribution;
}>): Promise<PluginActionExecutorResult | null> {
  if (!isExecutablePluginRuntimeRegistry(params.registry)) {
    return null;
  }
  const pluginId = params.action.pluginId;
  if (!pluginId) {
    return null;
  }
  await params.registry.activateContributionsOnDemand([{
    pluginId,
    family: 'actions',
    localId: params.action.definition.id,
  }]);
  const activationFailure = params.registry.targetActivationFacts?.find((fact) => (
    fact.pluginId === pluginId && fact.status === 'unavailable'
    && fact.required.some((registration) => (
      registration.family === 'actions' && registration.localId === params.action.definition.id
    ))
  ))?.diagnostics[0];
  if (!activationFailure) {
    return null;
  }
  const diagnostic = readPluginActionFailureAuthorPayload(activationFailure.details);
  const cause = readPluginModuleFailureCause(activationFailure.details);
  return actionHandlerNotStartedFailure(
    activationFailure.code,
    activationFailure.message,
    diagnostic.failureCause ? { failureCause: diagnostic.failureCause } : cause ? { code: cause.code } : undefined,
  );
}

export async function executeContributedAction(params: Readonly<{
  registry?: ResolvedContributionRegistry;
  runtimeRegistry?: ResolvedExecutablePluginRuntimeRegistry;
  actionId: ActionId | string;
  input?: unknown;
  /** Host routing metadata, never contributed business input or a UI authority claim. */
  clientId?: string;
  /** Host-only read constraint; checked before activation on this registry lease. */
  requiredDangerLevel?: 'safe';
  resolveEnvironmentApprovalScope?: import('@happier-dev/protocol/actions').ActionExecutorDeps['resolveEnvironmentApprovalScope'];
  requiredReadOnly?: true;
  resourceSessionId?: string;
  readObservation?: import('../targetActionRegistry').InvokeTargetActionParams['readObservation'];
  /** Host-admitted settings snapshot; scoped runtimes must never consult ambient Account policy. */
  actionsSettings?: ActionsSettingsV1;
  /** Host-private request from ActionsService.executeWithExecutionOrigin only. */
  captureExecutionOrigin?: true;
  /** Original root authority, captured before normalization or secret projection. */
  approvalExecutionOrigin?: ApprovalExecutionOriginV1;
  /** Set only by the daemon host that retains the approval waiter. */
  daemonHoldsApprovalWaiter?: true;
  /** Private admitted host context; never supplied through Action input. */
  approvalContext?: ActionExecutorContext;
  /** Exact native review; consumed only after target admission, without granting role-policy admission. */
  reviewedChild?: HostReviewedChildPortV1;
  /** Equality-only precondition from ActionsService.executeWithExecutionOrigin only. */
  expectedExecutionOrigin?: PluginMachineExecutionOriginV1;
  /** Placement-only equality precondition; never a target selector. */
  expectedExecutionRouting?: PluginMachineExecutionRoutingV1;
  /** Exact daemon placement re-read from a durable target-Action approval subject. */
  expectedApprovalReplayPlacement?: TargetActionApprovalReplayPlacementV1;
  /**
   * Host-stamped targeted-contribution admission fence. It is never Action
   * input, a target selector, or public SDK call option.
   */
  expectedContributorOccurrenceId?: string;
  /**
   * Optional only when the host admitted this operation with a real runtime
   * materialization. Cold bundled contributors never manufacture this value.
   */
  expectedContributorMaterializationId?: string;
  /** Untrusted committed identity; the answering client resolves it after Action admission. */
  messageActionReference?: MessageActionReferenceV1;
  /** Opaque target-operation evidence forwarded only by the original handle owner. */
  admittedTargetedOperation?: AdmittedTargetedOperationExecutionRequest;
  /** A nested cross-realm call retains its original protocol and handler fence. */
  inheritedTargetedOperation?: Readonly<{
    targetProtocol: RehydratedPluginContributionPointOperationV1;
    beforeHandlerInvocation(): Promise<void>;
  }>;
  /** Private current managed-resource admission; never an SDK or Action-input field. */
  admittedManagedProviderOperation?: AdmittedManagedProviderOperationExecutionRequest;
  /** Private initial check/options credential scope; never a public call option. */
  admittedConnectedAccountPurposeBinding?: AdmittedConnectedAccountPurposeBindingExecutionRequest;
  requestCurrentIntent?: (request: TargetActionCurrentIntentRequest) => Promise<TargetActionCurrentIntentResult>;
  /** Host-stamped: the present person's own UI press reached this plugin-to-plugin call. */
  presentUserIntent?: 'confirmed';
  context: Readonly<{
    defaultSessionId?: string;
    /** Declared target capability surface. */
    surface?: PluginActionSurface;
    /** Actual host invocation origin, never inferred from diagnostic provenance. */
    invocationSurface?: PluginActionSurface;
    /** Receiver-admitted client/Account Action call, never a wire or SDK claim. */
    admittedPluginActionSurface?: 'plugin';
    /** Diagnostic provenance from the immediate plugin caller, never a policy surface. */
    originSurface?: PluginInvocationOriginSurface;
    /** Host-stamped caller provenance for plugin-to-plugin dispatch. */
    caller?: PluginInvocationCaller;
    /** Private original Action admission; never a target authorization surface or SDK input. */
    initiatingActionCaller?: import('@happier-dev/protocol/actions').ActionCaller;
    /** Bounded descriptive fact from the authenticated host-control transport. */
    startedBy?: import('@happier-dev/protocol').WorkflowRunStartedByV1;
    /** Host-private external API authority; never plugin-authored input. */
    externalActionContext?: PluginExternalActionContext;
    /**
     * Request-scoped mounted-caller revalidation from the ingress daemon. The
     * target Action owner consumes it exactly before invoking its handler.
     */
    isMountedCallerCurrent?: () => boolean | Promise<boolean>;
    /** Private admitted Account caller placement; never supplied through the wire or SDK. */
    approvalInputCustody?: 'live_only';
    /** Untrusted transient settlement from the mounted UI ingress only. */
    selectedActionInputCarrier?: PluginUiSelectedActionInputCarrierV1;
    /** Bounded whole-message disclosure stamped by the ingress host. */
    messageAction?: MessageActionAvailableSnapshotV1;
    signal?: AbortSignal;
    facts?: ContributionPolicyFacts;
    operationProgress?: TargetActionOperationProgressPort;
    observePluginExecution?: HostActionOperationRuntime['observePluginExecution'];
    operationRequestId?: string;
    operationRpcContext?: Parameters<HostActionOperationRuntime['observePluginExecution']>[0]['rpcContext']
      & Pick<RpcHandlerContext, 'callerInputAuthorization'>;
    /** Host-owned custody transition after final admission, before plugin code. */
    beforeHandlerInvocation?: () => Promise<void>;
  }>;
}>): Promise<PluginActionExecutionAttempt> {
  const actionId = String(params.actionId);
  if (!params.runtimeRegistry && !params.registry && isBuiltInActionId(actionId)) {
    return { matched: false };
  }

  const registry = params.runtimeRegistry
    ?? params.registry;
  if (!registry) {
    return { matched: false };
  }
  const contributes = readContributionRegistry(registry);
  const action = contributes.actionsById?.get(actionId);
  if (!action) {
    const identity = parseQualifiedPluginContributionKey(actionId);
    const admission = identity && contributes.pluginEnablementById?.[identity.pluginId];
    if (admission && admission.unavailableCode === 'plugin_account_census_failed') {
      return { matched: true, result: {
        ...actionHandlerNotStartedFailure(admission.unavailableCode, ACCOUNT_PLUGIN_CENSUS_UNAVAILABLE_MESSAGE),
        retryable: true,
        data: {
          ...(admission.unavailableCause ? { failureCause: admission.unavailableCause } : {}),
          ...(admission.unavailableRequestId ? { details: { requestId: admission.unavailableRequestId } } : {}),
        },
      } };
    }
    return { matched: false };
  }
  const trackedOperation = action.definition.execution?.target === 'daemon' ? action.definition.operation : undefined;
  const observeOperation = trackedOperation ? params.context.observePluginExecution : undefined;

  if (params.requiredDangerLevel === 'safe' && action.definition.dangerLevel !== 'safe') {
    return { matched: true, result: actionHandlerNotStartedFailure(
      'plugin_action_read_only_required', 'This source requires a read-only contributed Action',
    ) };
  }

  const surface = params.context.surface ?? 'cli';
  const invocationSurface = params.context.invocationSurface ?? surface;
  const clientTarget = (
    typeof action.definition.execution === 'object'
    && action.definition.execution !== null
    && 'target' in action.definition.execution
    && action.definition.execution.target === 'client'
  );
  const accountTarget = typeof action.definition.execution === 'object'
    && action.definition.execution !== null
    && 'target' in action.definition.execution
    && action.definition.execution.target === 'account';
  if ((params.requiredReadOnly || params.readObservation)
    && (clientTarget || !params.readObservation && (action.definition.readOnly === undefined || action.definition.readOnly === false))) {
    return { matched: true, result: actionHandlerNotStartedFailure(
      'plugin_action_read_only_required', 'This Resource requires an explicitly declared read operand',
    ) };
  }
  if (params.messageActionReference && !clientTarget) {
    return { matched: true, result: actionHandlerNotStartedFailure(
      'plugin_message_action_unavailable',
      'This Action cannot resolve an explicit client Message reference',
    ) };
  }
  if (params.clientId !== undefined && !clientTarget) {
    return { matched: true, result: actionHandlerNotStartedFailure(
      'client_routing_not_applicable', 'clientId is only supported for client-targeted Actions',
    ) };
  }
  // Only authenticated host automated origins can use the reverse channel.
  // Plugin provenance and host-private execution bindings cannot be flattened
  // into a host invocation on another process. An ordinary root invocation's
  // approval origin is descriptive custody, not a replay binding: the answering
  // client's canonical dispatcher still admits its own Action and approval.
  if (clientTarget && (
    (invocationSurface !== 'agent' && invocationSurface !== 'mcp' && invocationSurface !== 'cli')
    || params.context.caller !== undefined
    || params.context.externalActionContext !== undefined
    || params.captureExecutionOrigin !== undefined
    || params.expectedExecutionOrigin !== undefined
    || params.expectedExecutionRouting !== undefined
    || params.expectedApprovalReplayPlacement !== undefined
    || params.admittedTargetedOperation !== undefined
    || params.admittedManagedProviderOperation !== undefined
    || params.admittedConnectedAccountPurposeBinding !== undefined
  )) {
    return {
      matched: true,
      result: actionHandlerNotStartedFailure(
        'plugin_action_client_target_unavailable',
        'Client-target actions must execute on the invoking UI client',
      ),
    };
  }

  // An admitted client/Account Action calls the target on its plugin surface,
  // independently of the physical origin retained for confirmation. Otherwise
  // the declared-surface check follows the host-stamped invocation origin, not
  // the caller kind. A mounted Plugin UI invocation derives a plugin-kind
  // caller — the plugin that owns the validated mount — but its authority is
  // the user's UI interaction itself: the daemon ingress admits that caller
  // only after matching the request's mounted binding against the live
  // registry lease, so the `ui`/`voice` execution surface it stamped is UI
  // authority no direct plugin call can claim. The plugin runtime
  // (ActionsService) and background/automation ingresses are the real
  // plugin-authority callers and check the target's `plugin` surface.
  const pluginId = action.pluginId;
  if (!pluginId) {
    return {
      matched: true,
      result: actionHandlerNotStartedFailure(
        'plugin_action_handler_missing',
        'Plugin action requires a daemon entry handler',
      ),
    };
  }
  const contributedActionSettingsId = resolveContributedActionSettingsId(
    pluginId,
    action.definition.id,
  );
  const reviewedInput = params.input ?? null;
  const reviewedOperation = contributedActionSettingsId
    ? readHostReviewedChildOperationV1(params.approvalContext, contributedActionSettingsId, reviewedInput) : null;
  const hasAdmittedReview = contributedActionSettingsId !== null
    && isHostAdmittedReviewedChildPolicyV1(reviewedOperation, contributedActionSettingsId, reviewedInput);
  const actionSurface = params.context.admittedPluginActionSurface
    ?? (invocationSurface === 'plugin' || invocationSurface === 'background' ? 'plugin' : invocationSurface);
  if (!hasAdmittedReview && action.definition.surfaces[actionSurface] !== true) {
    return {
      matched: true,
      result: actionHandlerNotStartedFailure(
        'plugin_action_unavailable',
        'Plugin action is not available on the requested surface',
      ),
    };
  }
  const scopedActionsSettings = params.actionsSettings;
  const actionSettingsProvider = scopedActionsSettings
    ? { getActionsSettings: () => scopedActionsSettings }
    : createActionSettingsProvider();
  const accountActionsSettings = actionSettingsProvider.getActionsSettings();
  const profiledActionsSettings = resolveProfiledActionsSettingsV1(accountActionsSettings,
    params.approvalContext?.approvalProfileId, {
      boundProfile: params.approvalContext?.approvalProfile ?? null,
      approvalProfileTeamOrGroupDerived: params.approvalContext?.approvalProfileTeamOrGroupDerived,
      context: params.approvalContext,
    }).settings;
  // A present person's own UI press reached this Action through a plugin without
  // reviewing it. The Action's own policy decides as that press (owner 2026-11-15,
  // option A): UI-surface defaults and Settings, plus the plugin row it is called on.
  const approvalContextForPress = params.approvalContext;
  const ownPressChild = params.presentUserIntent === 'confirmed' && !hasAdmittedReview && !params.reviewedChild
    && actionSurface === 'plugin' && approvalContextForPress?.surface === 'ui'
    && (isPresentUserHostInvocation(approvalContextForPress)
      || isHomeAdmittedPresentUserHostInvocation(approvalContextForPress, 'action.invoke'));
  // An admitted review finishes after a later Off (next natural boundary). An own
  // press child is checked on its own surface and as that UI press.
  const settingsUnavailable = hasAdmittedReview ? null
    : checkContributedActionSettingsAvailability({ action, surface: actionSurface,
      actionsSettings: profiledActionsSettings })
    ?? (ownPressChild ? checkContributedActionSettingsAvailability({ action, surface: 'ui',
      actionsSettings: profiledActionsSettings }) : null);
  if (settingsUnavailable) return { matched: true, result: settingsUnavailable };

  const runtimeRegistry = isExecutablePluginRuntimeRegistry(registry)
    ? registry
    : null;
  if (accountTarget !== (runtimeRegistry?.executionRealm === 'account')) {
    return { matched: true, result: actionHandlerNotStartedFailure(
      runtimeRegistry?.executionRealm === 'account' ? 'plugin_action_machine_required' : 'plugin_action_execution_placement_unavailable',
      'The Action is unavailable in this execution host',
    ) };
  }
  const managedCustodyInput = { contributes, runtimeRegistry, action, operation: params.admittedManagedProviderOperation,
    probeBinding: params.admittedConnectedAccountPurposeBinding };
  const managedCustodyRefusal = await checkManagedProviderOperationCustody({ ...managedCustodyInput,
    input: params.input, approvalContext: params.approvalContext });
  if (managedCustodyRefusal !== null) return { matched: true, result: managedCustodyRefusal };
  const isManagedCustodyCurrent = () => isAdmittedManagedProviderCustodyCurrent(managedCustodyInput);
  const admittedTargetedOperation = params.admittedTargetedOperation;
  const expectedContributorOccurrenceId = admittedTargetedOperation === undefined
    ? params.expectedContributorOccurrenceId
    : admittedTargetedOperation.contributorOccurrenceId;
  const expectedContributorMaterializationId =
    params.expectedContributorMaterializationId;
  if (
    admittedTargetedOperation !== undefined
    && params.expectedContributorOccurrenceId !== undefined
    && params.expectedContributorOccurrenceId
      !== admittedTargetedOperation.contributorOccurrenceId
  ) {
    return { matched: true, result: admittedTargetedOperationInvalid() };
  }
  if (
    expectedContributorMaterializationId !== undefined
    && expectedContributorOccurrenceId === undefined
  ) {
    return { matched: true, result: admittedContributorOccurrenceRetired() };
  }
  if (
    admittedTargetedOperation !== undefined
    && !matchesAdmittedTargetedOperation(admittedTargetedOperation, action, params.context.caller)
  ) {
    return { matched: true, result: admittedTargetedOperationInvalid() };
  }
  if (clientTarget) {
    const currentOccurrenceId = runtimeRegistry?.readPluginOccurrenceId?.(pluginId);
    const contributorOccurrenceId = expectedContributorOccurrenceId ?? currentOccurrenceId;
    if (!contributorOccurrenceId || !await isExpectedPluginCurrent({
      runtimeRegistry, pluginId, expectedOccurrenceId: contributorOccurrenceId,
      ...(expectedContributorMaterializationId === undefined ? {} : {
        expectedMaterializationId: expectedContributorMaterializationId,
      }),
      requireMaterialization: expectedContributorMaterializationId !== undefined,
    })) {
      return { matched: true, result: admittedContributorOccurrenceRetired() };
    }
    if (params.context.signal?.aborted) {
      return { matched: true, result: actionHandlerNotStartedFailure('plugin_action_aborted', 'Action invocation was cancelled') };
    }
    if (!runtimeRegistry?.executeClientAction) {
      return { matched: true, result: actionHandlerNotStartedFailure(
        params.clientId ? 'client_not_available' : 'plugin_action_client_target_unavailable', 'No answering UI client is available',
      ) };
    }
    const actionRequestId = params.approvalContext?.actionRequestId ?? params.context.actionRequestId;
    const request = UiContributedActionExecuteRequestV1Schema.safeParse({
      v: 1, action: { pluginId, localId: action.definition.id },
      input: params.input ?? null, surface: invocationSurface,
      ...(actionRequestId ? { actionRequestId } : {}),
      ...(params.messageActionReference ? { messageActionReference: params.messageActionReference } : {}),
      expectedContributorOccurrenceId: contributorOccurrenceId,
      ...(params.context.defaultSessionId === undefined ? {} : { defaultSessionId: params.context.defaultSessionId }),
      ...(params.requiredDangerLevel === undefined ? {} : { requiredDangerLevel: params.requiredDangerLevel }),
    });
    if (!request.success) {
      return { matched: true, result: actionHandlerNotStartedFailure('plugin_action_input_invalid', 'Client Action request is invalid') };
    }
    // The host-stamped admission names the acting Account; the daemon's client transport
    // reaches only its own Account's Apps, whichever host route invoked this Action.
    const principalAccountId = readActionPrincipalAccountId(params.approvalContext);
    return { matched: true, result: await runtimeRegistry.executeClientAction(request.data, {
      ...(params.context.signal ? { signal: params.context.signal } : {}),
      ...(principalAccountId ? { principalAccountId } : {}),
      ...(params.clientId === undefined ? {} : { clientId: params.clientId }),
    }) };
  }
  const targetActionInvocations = runtimeRegistry
    ? runtimeRegistry.targetActionInvocations
    : undefined;
  if (runtimeRegistry && targetActionInvocations?.expects(pluginId, action.definition.id)) {
    // Occurrence admission precedes activation: a retired handle must not
    // activate its replacement or be reported as a missing handler.
    const checkAdmittedCurrentness = async (): Promise<PluginActionExecutorResult | null> => {
      if (expectedContributorOccurrenceId !== undefined
        && !(await isExpectedPluginCurrent({
          runtimeRegistry,
          pluginId,
          expectedOccurrenceId: expectedContributorOccurrenceId,
          expectedMaterializationId: expectedContributorMaterializationId,
          requireMaterialization: true,
        }))) {
        return admittedContributorOccurrenceRetired();
      }
      if (admittedTargetedOperation !== undefined
        && !(await isExpectedPluginCurrent({
          runtimeRegistry,
          pluginId: admittedTargetedOperation.target.pluginId,
          expectedOccurrenceId: admittedTargetedOperation.target.occurrenceId,
          requireMaterialization: false,
        }))) {
        return admittedTargetOccurrenceRetired();
      }
      return null;
    };
    if (!targetActionInvocations.has(pluginId, action.definition.id)) {
      const beforeDemandCurrentness = await checkAdmittedCurrentness();
      if (beforeDemandCurrentness !== null) {
        return { matched: true, result: beforeDemandCurrentness };
      }
      let activationFailure: PluginActionExecutorResult | null;
      try {
        activationFailure = await activateOwningPluginForAction({
          registry: runtimeRegistry,
          contributes,
          action,
        });
      } catch (error) {
        activationFailure = actionHandlerNotStartedFailure(
          'plugin_activation_failed',
          projectPluginFailureText(error),
          error,
        );
      }
      if (activationFailure || !targetActionInvocations.has(pluginId, action.definition.id)) {
        // Failed activation can retire its own occurrence. Preserve that cause;
        // stale handles were already refused before demand activation.
        return {
          matched: true,
          result: activationFailure ?? await checkAdmittedCurrentness() ?? actionHandlerNotStartedFailure(
            'plugin_action_handler_missing',
            'Declared target action did not publish a committed generation handler',
          ),
        };
      }
    }
    const requiresExecutionOrigin = params.captureExecutionOrigin === true
      || params.expectedExecutionOrigin !== undefined
      || params.expectedExecutionRouting !== undefined;
    const beforeExecutionOrigin = requiresExecutionOrigin
      ? await resolveCurrentTargetExecutionOrigin(
          runtimeRegistry,
          pluginId,
          params.context.signal,
        )
      : null;
    if (beforeExecutionOrigin && beforeExecutionOrigin.status !== 'resolved') {
      return {
        matched: true,
        result: actionHandlerNotStartedFailure(
          beforeExecutionOrigin.status === 'aborted'
            ? 'plugin_action_aborted'
            : 'plugin_action_execution_origin_unavailable',
          beforeExecutionOrigin.status === 'aborted'
            ? 'Plugin action invocation was aborted'
            : 'Current target execution origin is unavailable',
        ),
      };
    }
    if (beforeExecutionOrigin?.status === 'resolved'
      && ((params.expectedExecutionOrigin !== undefined
        && !arePluginMachineExecutionOriginsEqual(params.expectedExecutionOrigin, beforeExecutionOrigin.origin))
        || (params.expectedExecutionRouting !== undefined
          && !arePluginMachineExecutionRoutingsEqual(
            params.expectedExecutionRouting,
            getPluginMachineExecutionRouting(beforeExecutionOrigin.origin),
          )))) {
      return {
        matched: true,
        result: actionHandlerNotStartedFailure(
          'plugin_action_execution_origin_mismatch',
          'Expected target execution origin does not match the current target',
        ),
      };
    }
    const beforeApprovalReplayPlacement = params.expectedApprovalReplayPlacement === undefined
      ? null
      : await resolveCurrentTargetApprovalReplayPlacement(
          runtimeRegistry,
          pluginId,
          params.context.signal,
        );
    if (beforeApprovalReplayPlacement && beforeApprovalReplayPlacement.status !== 'resolved') {
      return {
        matched: true,
        result: actionHandlerNotStartedFailure(
          beforeApprovalReplayPlacement.status === 'aborted'
            ? 'plugin_action_aborted'
            : 'plugin_action_execution_origin_unavailable',
          beforeApprovalReplayPlacement.status === 'aborted'
            ? 'Plugin action invocation was aborted'
            : 'Current target approval replay placement is unavailable',
        ),
      };
    }
    if (beforeApprovalReplayPlacement?.status === 'resolved'
      && params.expectedApprovalReplayPlacement !== undefined
      && (
        beforeApprovalReplayPlacement.placement.serverId
          !== params.expectedApprovalReplayPlacement.serverId
        || beforeApprovalReplayPlacement.placement.machineId
          !== params.expectedApprovalReplayPlacement.machineId
      )) {
      return {
        matched: true,
        result: actionHandlerNotStartedFailure(
          'plugin_action_execution_origin_mismatch',
          'Persisted target approval does not match the current target execution origin',
        ),
      };
    }
    // The occurrence fence follows every await above (demand activation,
    // execution origin, replay placement), immediately before the target
    // registry admits the handler. `beforeHandlerInvocation` covers the only
    // later await on a person.
    const beforeHandlerCurrentness = await checkAdmittedCurrentness();
    if (beforeHandlerCurrentness !== null) {
      return { matched: true, result: beforeHandlerCurrentness };
    }
    const targetProtocol = admittedTargetedOperation?.targetProtocol ?? params.inheritedTargetedOperation?.targetProtocol;
    const validatedInput = targetProtocol === undefined
      ? null
      : validateTargetedOperationInput(targetProtocol, params.input);
    if (validatedInput !== null && !validatedInput.ok) {
      return { matched: true, result: validatedInput.result };
    }
    const caller = params.context.caller?.kind === 'plugin'
      ? Object.freeze({
          ...params.context.caller,
          ...(params.context.originSurface
            ? { originSurface: params.context.originSurface }
            : {}),
        })
      : params.context.caller;
    const replayPlacement = params.expectedApprovalReplayPlacement;
    const sharedRequester = params.approvalContext !== undefined && isSharedRequesterActionV1(params.approvalContext);
    // Agent and MCP callers get the operation receipt at admission. A live-only Ask
    // then waits inside that operation, held by this daemon (F10, ruling B).
    const admissionResponse = actionSurface !== 'plugin' && (invocationSurface === 'agent' || invocationSurface === 'mcp')
      && !params.approvalContext?.approvedActionReplay && !params.expectedApprovalReplayPlacement;
    let announceLiveAsk: ((artifactId: string) => void) | undefined;
    const liveAsk = observeOperation && trackedOperation && admissionResponse && params.daemonHoldsApprovalWaiter
      ? new Promise<string>(resolve => { announceLiveAsk = resolve; }) : undefined;
    // The pressing person reviews in their own UI: the parent carries its review
    // back for a digest-bound re-press. Never a self-approval Artifact.
    const requestCurrentIntent = ownPressChild
      ? async (): Promise<TargetActionCurrentIntentResult> => ({ status: 'unavailable', code: 'action_interactive_review_required' })
      // Durable replay already acquired placement and holds the confirmed Ask.
      : params.requestCurrentIntent && !replayPlacement
      ? async (request: TargetActionCurrentIntentRequest): Promise<TargetActionCurrentIntentResult> => {
          const projectedInput = projectTargetActionApprovalInput(request.action.input, request.action.secretInputPaths ?? []);
          // Declared live custody, confidential input and Account hosts without
          // a replay-placement producer belong to the existing live waiter.
          const liveOnly = params.context.approvalInputCustody === 'live_only'
            || action.definition.approvalInputCustody === 'live_only'
            || (projectedInput?.confidentialPaths.length ?? 0) > 0
            || (accountTarget && !runtimeRegistry.resolveCurrentPluginApprovalReplayPlacement);
          const requestedSurface = request.invocationSurface ?? request.surface;
          const deferredSurface = requestedSurface === 'api' || requestedSurface === 'cli'
            || requestedSurface === 'agent' || requestedSurface === 'mcp' ? requestedSurface : null;
          const needsApprovalPlacement = (deferredSurface !== null || sharedRequester)
            && pluginActionRequiresPresentUserIntent(request.action, requestedSurface, request.action.input);
          if (!liveOnly && !needsApprovalPlacement) return await params.requestCurrentIntent!(request);
          const retainedInput = { action: { pluginId: request.action.pluginId, localId: request.action.localId },
            input: projectedInput?.input ?? request.action.input };
          const requesterAdmission = resolveApprovalRequesterConfirmationV1({ context: params.approvalContext,
            actionId: 'action.invoke', input: retainedInput, required: sharedRequester });
          if (!requesterAdmission.ok) return { status: 'unavailable', code: requesterAdmission.errorCode };
          const { requesterConfirmation } = requesterAdmission;
          let placement: TargetActionApprovalReplayPlacementV1 | undefined;
          let placementServerIdentityId: string | undefined;
          // Standalone live custody needs no Machine. A daemon-held waiter must
          // retain its host's own placement so another client can deliver consent.
          if (!liveOnly || params.daemonHoldsApprovalWaiter) {
            const currentPlacement = await resolveCurrentTargetApprovalReplayPlacement(
              runtimeRegistry,
              pluginId,
              request.signal,
            );
            if (currentPlacement.status === 'aborted' || (!liveOnly && currentPlacement.status !== 'resolved')) {
              return {
                status: 'unavailable',
                code: currentPlacement.status === 'aborted'
                  ? 'plugin_action_aborted'
                  : 'plugin_action_execution_origin_unavailable',
              };
            }
            if (currentPlacement.status === 'resolved') {
              placementServerIdentityId = currentPlacement.placement.serverIdentityId;
              placement = Object.freeze({
                serverId: currentPlacement.placement.serverId,
                machineId: currentPlacement.placement.machineId,
                ...(params.context.defaultSessionId === undefined
                  ? {}
                  : { defaultSessionId: params.context.defaultSessionId }),
              });
            }
          }
          const originSurface = deferredSurface ?? (requestedSurface === 'plugin' || placement ? parseActionSurfaceKey(requestedSurface) : null);
          let originContext = params.approvalContext;
          let resealedRequester = false;
          const retainedAuthorization = params.approvalExecutionOrigin?.externalActionExecutionAuthorization;
          const admittedAuthorization = originContext?.externalActionExecutionAuthorization;
          if (retainedAuthorization?.requesterAccountContext && admittedAuthorization) {
            if (retainedAuthorization.token !== admittedAuthorization.token
              || !sameStrictJsonValue(retainedAuthorization.binding, admittedAuthorization.binding)) {
              return { status: 'unavailable', code: 'approval_context_unavailable' };
            }
            // Re-entry signs the already retained proof, not a newly randomized
            // box. Actual execution continues to use the reopened private ports.
            originContext = { ...originContext, externalActionExecutionAuthorization: retainedAuthorization };
          }
          const authorization = originContext?.externalActionExecutionAuthorization;
          const binding = authorization?.binding;
          if (!liveOnly && authorization && binding && 'authentication' in binding
            && (binding.authentication.kind === 'account' || binding.authentication.kind === 'terminal')
            && !binding.sessionActionOrigin && !binding.workflowActionOrigin
            && !isOriginalOwnAccountActionCustody(binding) && !authorization.requesterAccountContext) {
            // Live admission deliberately strips the incoming credential box.
            // Durable replay must retain the same admitted source, not borrow
            // the later approval decider's Account. Its private owner alone can
            // reseal that exact root for this installation.
            const installation = readInstallationIdentityIfExistsSync();
            const seal = authorization.requesterAccountProjection?.sealRequesterAccountContext;
            if (!installation || installation.installationId !== binding.installationId || !seal) {
              return { status: 'unavailable', code: 'approval_context_unavailable' };
            }
            const sealed = await seal({ authorization, purpose: { kind: 'external_action' },
              installationPublicKey: decodeBase64(installation.publicKey, 'base64url') });
            if (!sealed?.requesterAccountContext || sealed.token !== authorization.token
              || !sameStrictJsonValue(sealed.binding, binding)) {
              return { status: 'unavailable', code: 'approval_context_unavailable' };
            }
            originContext = { ...originContext, externalActionExecutionAuthorization: sealed };
            resealedRequester = true;
          }
          // The outer Action captures caller authority before this target's
          // placement is known. Fill only its absent Machine from the admitted
          // host; existing routing, caller, credential and input proof stay exact.
          const capturedOrigin = !requesterConfirmation && !resealedRequester ? params.approvalExecutionOrigin : undefined;
          const executionOriginV1 = (capturedOrigin && placement && capturedOrigin.machineId === undefined
            ? { ...capturedOrigin, machineId: placement.machineId }
            : capturedOrigin) ?? (originSurface === null ? null : buildApprovalExecutionOriginV1({
            actionId: 'action.invoke',
            input: requesterConfirmation ? retainedInput : { action: { pluginId: request.action.pluginId, localId: request.action.localId }, input: request.action.input },
            ...(requesterConfirmation ? { requesterConfirmation } : {}),
            context: {
              ...originContext,
              serverIdentityId: originContext?.serverIdentityId ?? placementServerIdentityId,
              surface: originSurface,
              actionCaller: params.approvalContext?.actionCaller ?? params.context.initiatingActionCaller ?? { kind: 'host' },
              ...(placement ? { serverId: placement.serverId, executionRunTargetMachineId: placement.machineId } : {}),
              actionRequestId: params.approvalContext?.actionRequestId ?? params.approvalExecutionOrigin?.requestId ?? randomUUID(),
            },
            targetSessionId: placement?.defaultSessionId ?? params.context.defaultSessionId ?? null,
          }));
          if (requesterConfirmation && (!executionOriginV1?.externalActionExecutionAuthorization || !executionOriginV1.externalActionInputSignature)) {
            return { status: 'unavailable', code: 'approval_requester_unavailable' };
          }
          const result = await params.requestCurrentIntent!({
            ...request,
            ...(liveOnly ? { approvalInputCustody: 'live_only' } : {}),
            ...(liveOnly && announceLiveAsk ? { onLiveApprovalRequested: announceLiveAsk } : {}),
            ...(placement ? { replayPlacement: placement } : {}),
            ...(executionOriginV1 ? { executionOriginV1 } : {}),
            ...(requesterConfirmation ? { requesterConfirmation } : {}),
          });
          return result;
        }
      : params.requestCurrentIntent;
    const exactPurposeBindingSubjectId = params.admittedManagedProviderOperation?.exactPurposeBindingSubjectId
      ?? params.admittedConnectedAccountPurposeBinding?.exactPurposeBindingSubjectId;
    const executeBrokeredAction = params.admittedManagedProviderOperation?.executeBrokeredAction
      ?? params.admittedConnectedAccountPurposeBinding?.executeBrokeredAction;
    const nativeCredentials = params.admittedManagedProviderOperation?.managedNativeCredentials;
    const requestId = params.context.operationRequestId ?? params.approvalContext?.actionRequestId ?? undefined;
    const requesterAccount = readRequesterAccountActionContext(
      params.approvalContext?.externalActionExecutionAuthorization
        ?? params.context.operationRpcContext?.externalActionExecutionAuthorization
        ?? params.context.operationRpcContext?.callerInputAuthorization,
    )?.savedSecretOperationContext;
    // Native consent answers review only. The target's original context still
    // admits its Session, availability and host-access policy below.
    const reviewContext = params.reviewedChild
      ? { ...params.approvalContext, hostReviewedChild: params.reviewedChild }
      : params.approvalContext;
    const admittedReviewOperation = params.reviewedChild && contributedActionSettingsId !== null
      ? readHostReviewedChildOperationV1(reviewContext, contributedActionSettingsId, reviewedInput)
      : reviewedOperation;
    const reviewAdmitted = params.reviewedChild && contributedActionSettingsId !== null
      ? isHostAdmittedReviewedChildPolicyV1(admittedReviewOperation, contributedActionSettingsId, reviewedInput)
      : hasAdmittedReview;
    const targetInvocation = {
      ...(requestId === undefined ? {} : { requestId }),
      ...(executeBrokeredAction ? { executeBrokeredAction } : {}),
      pluginId,
      localId: action.definition.id,
      input: validatedInput === null ? params.input : validatedInput.value,
      ...(params.requiredReadOnly ? { requiredReadOnly: true as const } : {}),
      ...(params.resourceSessionId ? { resourceSessionId: params.resourceSessionId } : {}),
      ...(params.readObservation ? { readObservation: params.readObservation } : {}),
      surface: actionSurface,
      invocationSurface: ownPressChild ? 'ui' as const : invocationSurface,
      invocationAuthority: params.approvalContext?.authority ?? 'account_automation',
      ...(params.approvalContext ? { approvalContext: params.approvalContext } : {}),
      ...(requesterAccount ? { requesterAccount } : {}),
      ...(params.resolveEnvironmentApprovalScope ? { resolveEnvironmentApprovalScope: params.resolveEnvironmentApprovalScope } : {}),
      ...(params.approvalContext?.invocationServices?.machineConnectorSecrets
        ? { machineConnectorSecrets: params.approvalContext.invocationServices.machineConnectorSecrets }
        : {}),
      ...(caller ? { caller } : {}),
      ...(params.context.initiatingActionCaller ? { initiatingActionCaller: params.context.initiatingActionCaller } : {}),
      ...(params.context.startedBy ? { startedBy: params.context.startedBy } : {}),
      ...(params.context.externalActionContext
        ? { externalActionContext: params.context.externalActionContext }
        : {}),
      ...(admittedTargetedOperation === undefined
        ? {}
        : {
          expectedAdmittedTargetOccurrence: Object.freeze({
            pluginId: admittedTargetedOperation.target.pluginId,
            occurrenceId: admittedTargetedOperation.target.occurrenceId,
          }),
        }),
      ...(params.context.isMountedCallerCurrent
        ? { isMountedCallerCurrent: params.context.isMountedCallerCurrent }
        : {}),
      ...(params.context.selectedActionInputCarrier
        ? { selectedActionInputCarrier: params.context.selectedActionInputCarrier }
        : {}),
      ...(params.context.messageAction ? { messageAction: params.context.messageAction } : {}),
      ...(params.context.defaultSessionId ? { sessionId: params.context.defaultSessionId } : {}),
      ...(params.context.signal && !observeOperation ? { signal: params.context.signal } : {}),
      ...(params.context.facts ? { facts: params.context.facts } : {}),
      ...(params.context.operationProgress
        ? { operationProgress: params.context.operationProgress }
        : {}),
      ...(params.admittedManagedProviderOperation || params.admittedConnectedAccountPurposeBinding || params.context.beforeHandlerInvocation || params.inheritedTargetedOperation || (accountTarget && runtimeRegistry.revalidateAccountExecution)
        ? { beforeHandlerInvocation: async () => {
            await params.context.beforeHandlerInvocation?.();
            await params.inheritedTargetedOperation?.beforeHandlerInvocation();
            // Approval may wait while Account availability changes. Admit the
            // callee after the caller's admission, once, before its handler.
            if (accountTarget && runtimeRegistry.revalidateAccountExecution
              && !await runtimeRegistry.revalidateAccountExecution(pluginId, params.context.signal)) {
              throw new PluginError({ code: 'plugin_action_generation_retired', message: 'The Account target is retired' });
            }
            if (!await isManagedCustodyCurrent()) {
              throw new PluginError({ code: 'plugin_managed_provider_operation_custody_invalid',
                message: 'The native provisioner role requires current managed-resource custody' });
            }
          } }
        : {}),
      ...(exactPurposeBindingSubjectId === undefined
        ? {}
        : { exactPurposeBindingSubjectId }),
      ...((params.admittedManagedProviderOperation?.onProcessOutput ?? params.approvalContext?.invocationServices?.deploymentBuildOutput) === undefined
        ? {}
        : { execOutputObserver: params.admittedManagedProviderOperation?.onProcessOutput
            ?? params.approvalContext?.invocationServices?.deploymentBuildOutput }),
      ...(params.admittedManagedProviderOperation?.bindProcessInput === undefined
        ? {}
        : { execChannelInput: params.admittedManagedProviderOperation.bindProcessInput }),
      ...(params.admittedManagedProviderOperation?.execTimeoutMs === undefined
        ? {}
        : { execInvocationTimeoutMs: params.admittedManagedProviderOperation.execTimeoutMs }),
      ...(params.admittedManagedProviderOperation?.readBootstrapCredential
        ? { managedBootstrapCredential: {
            role: params.admittedManagedProviderOperation.role,
            readBootstrapCredential: params.admittedManagedProviderOperation.readBootstrapCredential,
            ...(params.admittedManagedProviderOperation.readGuestHostCredential
              ? { readGuestHostCredential: params.admittedManagedProviderOperation.readGuestHostCredential } : {}),
            isCurrent: isManagedCustodyCurrent,
          } }
        : {}),
      ...((params.admittedManagedProviderOperation?.managedSshHostTrust ?? params.approvalContext?.invocationServices?.managedSshHostTrust)
        ? { managedSshHostTrust: params.admittedManagedProviderOperation?.managedSshHostTrust
            ?? params.approvalContext?.invocationServices?.managedSshHostTrust } : {}),
      ...(nativeCredentials
        ? { managedNativeCredentials: nativeCredentials }
        : {}),
      ...(replayPlacement ? { replayPlacement } : {}),
      ...(params.expectedApprovalReplayPlacement === undefined
        ? {}
        : { requireCurrentIntent: true as const }),
      ...(contributedActionSettingsId === null
        ? {}
        : {
          isApprovalRequiredByActionSettings: (manifestDefault: boolean, parsedInput?: unknown,
            environmentAdmission?: import('@happier-dev/protocol/actions/actionApprovalPolicy').ActionEnvironmentApprovalScopeAdmissionV1) => {
            // The target owner parsed this invocation before asking policy.
            // Consent binds its semantic operand, not schema-produced defaults.
            const routing = resolveActionApprovalRouting({ actionId: 'action.invoke', profileActionId: contributedActionSettingsId,
              spec: getActionSpec('action.invoke'), settings: accountActionsSettings,
              approvalScope: environmentAdmission?.scope ?? undefined,
              ...(environmentAdmission?.targetApproval ? { targetApproval: environmentAdmission.targetApproval } : {}),
              defaultSafety: action.definition.safety, input: admittedReviewOperation ? reviewedInput : parsedInput,
              defaultUiConfirmation: manifestDefault,
              defaultConfirmation: manifestDefault || sharedRequester && action.definition.dangerLevel === 'writesRemote'
                && pluginActionDeclarationRequiresConfirmationForInput(action.definition, invocationSurface, parsedInput, params.approvalContext?.authority),
              reviewAdmitted,
              approvedOperation: admittedReviewOperation,
              context: { ...reviewContext,
                surface: admittedReviewOperation || ownPressChild ? reviewContext?.surface : actionSurface,
              },
            });
            // The person also chose Ask for this Action's plugin callers; it asks them too.
            const pluginAsk = ownPressChild && readExplicitActionApprovalPreferenceV1(contributedActionSettingsId, profiledActionsSettings,
              { ...reviewContext, surface: 'plugin' }, environmentAdmission?.scope ?? undefined) === true;
            return routing.required || routing.uiConfirmationRequired === true || pluginAsk;
          },
        }),
      ...(requestCurrentIntent ? { requestCurrentIntent } : {}),
    } as const;
    const projectTargetResult = async (targetResult: Awaited<ReturnType<
      typeof targetActionInvocations.invoke
    >>): Promise<PluginActionExecutorResult> => {
      if (targetResult.status === 'deferred') {
        return {
          ok: true,
          result: { kind: 'approval_request_created', artifactId: targetResult.artifactId, actionId: 'action.invoke' },
          deferredApprovalArtifactId: targetResult.artifactId,
        };
      }
      const validatedResult = targetResult.status !== 'executed' || targetProtocol === undefined || params.readObservation !== undefined
        ? null
        : validateTargetedOperationResult(targetProtocol, targetResult.value);
      if (validatedResult !== null && !validatedResult.ok) return validatedResult.result;
      if (targetResult.status === 'executed') {
        // Origin and routing were decided once at admission, before the effect.
        // A known settlement survives later retirement so callers never retry
        // an effect that ran. The origin-bearing request reports the admitted
        // origin as execution evidence; a changed or retired origin is refused
        // at the next admission, never granted later routing authority.
        return {
          ok: true,
          result: validatedResult === null ? targetResult.value : validatedResult.value,
          ...(targetResult.automationNotices ? { automationNotices: targetResult.automationNotices } : {}),
          ...(beforeExecutionOrigin?.status === 'resolved'
            ? { executionOrigin: beforeExecutionOrigin.origin }
            : {}),
        };
      }
      const inputFailure = targetResult.status === 'invalid' && targetResult.code === 'plugin_action_input_schema_invalid'
        && targetResult.issues ? actionInputIssueFailure(...targetResult.issues) : null;
      return {
        ok: false,
        errorCode: targetResult.code,
        ...(targetResult.automationNotices ? { automationNotices: targetResult.automationNotices } : {}),
        error: inputFailure ? targetResult.code : targetResult.code === 'approval_requester_unavailable'
          ? APPROVAL_REQUESTER_UNAVAILABLE_MESSAGE_V1 : targetResult.message,
        ...(inputFailure ? { details: inputFailure.details } : {}),
        ...(targetResult.retryable === undefined
          ? {}
          : { retryable: targetResult.retryable }),
        ...(targetResult.data === undefined ? {} : { data: targetResult.data }),
        ...(targetResult.actionHandlerInvocation === undefined
          ? {}
          : { actionHandlerInvocation: targetResult.actionHandlerInvocation }),
      };
    };
    if (observeOperation && trackedOperation) {
      params.context.signal?.throwIfAborted();
      // The held Ask's lifetime is the operation's, not the admitting call's.
      const heldAskLifetime = liveAsk ? new AbortController() : undefined;
      const preparing = targetActionInvocations.prepare(heldAskLifetime
        ? { ...targetInvocation, signal: heldAskLifetime.signal } : targetInvocation);
      const admitted = liveAsk
        ? await Promise.race([preparing.then(prepared => ({ prepared })), liveAsk.then(artifactId => ({ artifactId }))])
        : { prepared: await preparing };
      if ('prepared' in admitted && admitted.prepared.kind === 'settled') {
        return { matched: true, result: await projectTargetResult(admitted.prepared.result) };
      }
      const rawTitle = action.definition.title;
      const admittedReady = 'prepared' in admitted && admitted.prepared.kind === 'ready' ? admitted.prepared : undefined;
      const heldArtifactId = 'artifactId' in admitted ? admitted.artifactId : undefined;
      const observing = observeOperation({ actionId, title: resolvePluginLocalizedStringV2Text(rawTitle),
        operation: trackedOperation, input: targetInvocation.input,
        // An admitted SDK child consumes its handler result; its approval stays
        // visible through the retained operation while the caller waits.
        ...(actionSurface === 'plugin'
          ? { response: 'terminal' as const }
          : admissionResponse ? { response: 'admission' as const } : {}),
        failureResult: contributedActionFailureResult,
        ...(params.context.operationRpcContext ?? params.approvalContext
          ? { rpcContext: params.context.operationRpcContext ?? params.approvalContext } : {}),
        ...(requestId ? { requestId } : {}),
        ...(params.context.defaultSessionId ? { sessionId: params.context.defaultSessionId } : {}),
        execute: async ({ signal, operationProgress, operationAcceptance, operationOwnerUpdate }) => {
          // As with native host operations, early acceptance must not retire
          // the original requester's services while its actual handler runs.
          const authorization = params.approvalContext?.externalActionExecutionAuthorization
            ?? params.context.operationRpcContext?.externalActionExecutionAuthorization
            ?? params.context.operationRpcContext?.callerInputAuthorization;
          const release = readRequesterAccountActionContext(authorization)?.retain();
          try {
            let prepared: Awaited<typeof preparing>;
            if (admittedReady) prepared = admittedReady;
            else {
              // The person decides in the Inbox; cancelling the operation withdraws the Ask.
              const withdraw = () => heldAskLifetime?.abort();
              signal.addEventListener('abort', withdraw, { once: true });
              if (signal.aborted) withdraw();
              if (heldArtifactId) operationOwnerUpdate?.update({ progress: { phase: 'waiting_for_approval', label: 'Waiting for approval',
                approval: { kind: 'approval_request_created', artifactId: heldArtifactId, actionId: 'action.invoke' } } });
              try { prepared = await preparing; }
              finally {
                signal.removeEventListener('abort', withdraw);
                operationOwnerUpdate?.update({ progress: { label: 'Continuing' } });
              }
            }
            if (prepared.kind === 'settled') return await projectTargetResult(prepared.result);
            return await projectTargetResult(await prepared.run({
              signal, operationProgress, operationAcceptance, operationOwnerUpdate,
            }));
          }
          finally { await release?.(); }
        },
      });
      // An operation that was never admitted cannot hold the Ask; withdraw it.
      const observed = await observing.catch((error: unknown) => { heldAskLifetime?.abort(); throw error; });
      if (!observed.ok) heldAskLifetime?.abort();
      return { matched: true, result: observed.ok ? { ok: true, result: AgentRuntimeJsonValueV1Schema.parse(observed.result) } : observed };
    }
    const targetResult = await runTracedExternalActionStage('action.invoke', params.approvalContext?.actionRequestId,
      'contributed.target_invoke', () => targetActionInvocations.invoke(targetInvocation));
    return {
      matched: true,
      result: await projectTargetResult(targetResult),
    };
  }

  return {
    matched: true,
    result: actionHandlerNotStartedFailure(
      'plugin_action_handler_missing',
      'Plugin action is not bound through named activation',
    ),
  };
}
