import { ACTION_IDS } from '@happier-dev/protocol/actions/actionIds';
import { formatQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { MACHINE_PROVISIONER_EFFECT_ROLES_V1, readMachineProvisionerActionRolesV1, isMachineProvisionerBootstrapCredentialRoleV1, type MachineProvisionerRoleV1 } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import type { ActionExecutorContext, ActionId, QualifiedPluginActionId } from '@happier-dev/protocol/actions';
import { buildApprovalExecutionOriginV1 } from '@happier-dev/protocol/actions/actionExecutor';
import { actionInputIssueFailure } from '@happier-dev/protocol/actions/executor/actionInputValidation';
import { randomUUID } from 'node:crypto';
import { runTracedExternalActionStage } from '@/daemon/externalActions/externalActionPhase';
import { projectPluginActionUnavailableOutcomeCode, pluginActionRequiresPresentUserIntent, pluginActionDeclarationRequiresConfirmationForInput } from '@happier-dev/protocol/plugins/actions/invocation';
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
import { validateTargetedOperationInput, validateTargetedOperationResult } from '@happier-dev/plugin-sdk/host/registration';
import type { PluginProcessOutput } from '@happier-dev/plugin-sdk/exec';
import type { PluginActionHandlerInvocation } from '@happier-dev/plugin-sdk/actions';

import type {
  ResolvedActionContribution,
  ResolvedContributionRegistry,
} from '@/plugins/projection/registry/types';
import { projectPluginFailureText } from '@/plugins/runtime/lifecycle/utils';
import type { PluginActionSurface } from '@/plugins/runtime/types';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import type { ContributionPolicyFacts } from '@/plugins/runtime/policy/evaluate';
import type { TargetActionCurrentIntentRequest, TargetActionCurrentIntentResult } from '@/plugins/runtime/invocation/actionExecutor';
import type { TargetActionOperationProgressPort } from '@/plugins/runtime/invocation/targetActionRegistry';
import type { PluginExternalActionContext } from '@/plugins/runtime/invocation/services/types';
import { isActionEnabledByActionsSettings } from '@happier-dev/protocol/actions/actionSettings';
import { isApprovalRequiredByActionsSettings, isSharedRequesterActionV1 } from '@happier-dev/protocol/actions/actionApprovalPolicy';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { resolveRegistryConnectedAccountActionPurposeAuthorizations } from '@/daemon/connectedServices/purposeBindings/deriveRegistryConnectedAccountPurposeAuthorizations';

export type PluginActionExecutorResult = Readonly<
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

export type PreparedContributedActionInvocation = Readonly<{
  run(operationProgress?: TargetActionOperationProgressPort): Promise<PluginActionExecutorResult>;
}>;

export type PluginActionExecutionAttempt = Readonly<
  | { matched: false }
  | { matched: true; result: PluginActionExecutorResult }
>;

export type ClientContributedActionExecutor = (
  request: UiContributedActionExecuteRequestV1,
  options: Readonly<{ signal?: AbortSignal; clientId?: string }>,
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

/** Managed-resource custody supplied only by the authenticated host operation owner. */
export type AdmittedManagedProviderOperationExecutionRequest = Readonly<{
  managedId: string;
  homeId: string;
  intentRevision: number;
  controller: Readonly<{ machineId: string; installationId: string }>;
  contribution: Readonly<{ pluginId: string; localId: string; occurrenceId: string }>;
  role: MachineProvisionerRoleV1;
  /** Owned bytes from this exact row's retained SavedSecret; never an SDK selector. */
  readBootstrapCredential?(): Promise<Uint8Array>;
  /** Existing purpose lease; the operation owner retains its cleanup lifetime. */
  exactPurposeBindingSubjectId?: string;
  /** Host-only live output delivery while the native Exec Action is pending. */
  onProcessOutput?: (output: PluginProcessOutput) => void;
  /** Installer/task-owned budget for the explicitly selected native Exec process. */
  execTimeoutMs?: number | null;
  /** Rechecks the retained row/native reference, controller, intent and credential lease. */
  isCurrent(): boolean | Promise<boolean>;
}>;

/** Exact host-owned launch credential lease before a managed row exists. */
export type AdmittedConnectedAccountPurposeBindingExecutionRequest = Readonly<{
  exactPurposeBindingSubjectId: string;
  isCurrent(): boolean | Promise<boolean>;
}>;

async function checkManagedProviderOperationCustody(params: Readonly<{
  contributes: ResolvedContributionRegistry;
  runtimeRegistry: ResolvedExecutablePluginRuntimeRegistry | null;
  action: ResolvedActionContribution;
  operation?: AdmittedManagedProviderOperationExecutionRequest;
  probeBinding?: AdmittedConnectedAccountPurposeBindingExecutionRequest;
}>): Promise<PluginActionExecutorResult | null> {
  const matches = (params.contributes.machineProvisioners ?? []).flatMap((contribution) => {
    if (contribution.pluginId !== params.action.pluginId) return [];
    return readMachineProvisionerActionRolesV1(contribution.definition)
      .filter((binding) => binding.action === params.action.definition.id)
      .map(({ role }) => ({ contribution, role }));
  });
  const effectRole = matches.some((binding) => (
    MACHINE_PROVISIONER_EFFECT_ROLES_V1.some((role) => role === binding.role)
  ));
  const requiresManagedCustody = effectRole || matches.some(({ role }) => role === 'reconcile' || role === 'cleanup');
  if (params.operation === undefined && params.probeBinding === undefined && !requiresManagedCustody) return null;
  const invalid = () => actionHandlerNotStartedFailure(
    'plugin_managed_provider_operation_custody_invalid',
    'The native provisioner role requires current managed-resource custody',
  );
  if (params.probeBinding !== undefined) {
    const probe = params.probeBinding;
    const pluginId = params.action.pluginId;
    const expectedOccurrenceId = pluginId ? params.contributes.occurrenceIdsByPluginId?.[pluginId] : undefined;
    if (params.operation !== undefined || requiresManagedCustody || !params.runtimeRegistry
      || !pluginId || expectedOccurrenceId === undefined
      || !probe.exactPurposeBindingSubjectId.trim()
      || !matches.some(({ role }) => role === 'check' || role === 'options')) return invalid();
    try {
      if (await probe.isCurrent() !== true
        || params.runtimeRegistry.readPluginOccurrenceId?.(pluginId) !== expectedOccurrenceId) return invalid();
    } catch { return invalid(); }
    return null;
  }
  const operation = params.operation;
  if (!operation || !params.runtimeRegistry
    || !operation.managedId.trim() || !operation.homeId.trim()
    || !operation.controller.machineId.trim() || !operation.controller.installationId.trim()
    || !Number.isSafeInteger(operation.intentRevision) || operation.intentRevision < 0
    || operation.exactPurposeBindingSubjectId?.trim() === ''
    || (operation.onProcessOutput !== undefined && operation.role !== 'exec')
    || (operation.execTimeoutMs !== undefined && operation.role !== 'exec')
    || !matches.some(({ contribution, role }) => (
      role === operation.role
      && contribution.identity.pluginId === operation.contribution.pluginId
      && contribution.identity.localId === operation.contribution.localId
      && contribution.definition.id === operation.contribution.localId
    ))) return invalid();
  if (operation.exactPurposeBindingSubjectId === undefined) {
    const purposes = resolveRegistryConnectedAccountActionPurposeAuthorizations({
      registry: params.contributes,
      qualifiedActionId: buildQualifiedPluginContributionKey({ pluginId: operation.contribution.pluginId, localId: params.action.definition.id }),
    });
    // A retained managed invocation may not recapture mutable account defaults.
    // No declared use needs no lease; declared or unresolved use needs exact custody.
    if (!purposes || purposes.length > 0) return invalid();
  }
  try {
    if (await operation.isCurrent() !== true
      || params.runtimeRegistry.readPluginOccurrenceId?.(operation.contribution.pluginId)
        !== operation.contribution.occurrenceId) return invalid();
  } catch {
    return invalid();
  }
  return null;
}

type CurrentTargetExecutionOrigin = Readonly<
  | { status: 'resolved'; origin: PluginMachineExecutionOriginV1 }
  | { status: 'aborted' | 'unavailable' }
>;

type CurrentTargetApprovalReplayPlacement = Readonly<
  | { status: 'resolved'; placement: TargetActionApprovalReplayPlacementV1 }
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
): PluginActionExecutorResult {
  return {
    ok: false,
    errorCode,
    error,
    actionHandlerInvocation: 'notStarted',
  };
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
  return actionHandlerNotStartedFailure(
    activationFailure.code,
    activationFailure.message,
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
  /** Host-admitted settings snapshot; scoped runtimes must never consult ambient Account policy. */
  actionsSettings?: ActionsSettingsV1;
  /** Host-private request from ActionsService.executeWithExecutionOrigin only. */
  captureExecutionOrigin?: true;
  /** Original root authority, captured before normalization or secret projection. */
  approvalExecutionOrigin?: ApprovalExecutionOriginV1;
  /** Private admitted host context; never supplied through Action input. */
  approvalContext?: ActionExecutorContext;
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
  /** Private current managed-resource admission; never an SDK or Action-input field. */
  admittedManagedProviderOperation?: AdmittedManagedProviderOperationExecutionRequest;
  /** Private initial check/options credential scope; never a public call option. */
  admittedConnectedAccountPurposeBinding?: AdmittedConnectedAccountPurposeBindingExecutionRequest;
  requestCurrentIntent?: (request: TargetActionCurrentIntentRequest) => Promise<TargetActionCurrentIntentResult>;
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
    /** Host-owned custody transition after final admission, before plugin code. */
    beforeHandlerInvocation?: () => Promise<void>;
    capturePreparedInvocation?: (
      invocation: PreparedContributedActionInvocation,
    ) => void;
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
    return { matched: false };
  }

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
  const actionSurface = params.context.admittedPluginActionSurface
    ?? (invocationSurface === 'plugin' || invocationSurface === 'background' ? 'plugin' : invocationSurface);
  if (action.definition.surfaces[actionSurface] !== true) {
    return {
      matched: true,
      result: actionHandlerNotStartedFailure(
        'plugin_action_unavailable',
        'Plugin action is not available on the requested surface',
      ),
    };
  }

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
  const scopedActionsSettings = params.actionsSettings;
  const actionSettingsProvider = scopedActionsSettings
    ? { getActionsSettings: () => scopedActionsSettings }
    : createActionSettingsProvider();
  if (
    contributedActionSettingsId !== null
    && !isActionEnabledByActionsSettings(
      contributedActionSettingsId,
      actionSettingsProvider.getActionsSettings(),
      { surface: actionSurface },
    )
  ) {
    return {
      matched: true,
      result: actionHandlerNotStartedFailure(
        'plugin_action_unavailable',
        'Plugin action is disabled by Action settings',
      ),
    };
  }

  const runtimeRegistry = isExecutablePluginRuntimeRegistry(registry)
    ? registry
    : null;
  if (accountTarget !== (runtimeRegistry?.executionRealm === 'account')) {
    return { matched: true, result: actionHandlerNotStartedFailure(
      runtimeRegistry?.executionRealm === 'account' ? 'plugin_action_machine_required' : 'plugin_action_execution_placement_unavailable',
      'The Action is unavailable in this execution host',
    ) };
  }
  const checkManagedCustody = () => checkManagedProviderOperationCustody({
    contributes, runtimeRegistry, action, operation: params.admittedManagedProviderOperation,
    probeBinding: params.admittedConnectedAccountPurposeBinding,
  });
  const beforeManagedDemand = await checkManagedCustody();
  if (beforeManagedDemand !== null) return { matched: true, result: beforeManagedDemand };
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
    const request = UiContributedActionExecuteRequestV1Schema.safeParse({
      v: 1, action: { pluginId, localId: action.definition.id },
      input: params.input ?? null, surface: invocationSurface,
      ...(params.messageActionReference ? { messageActionReference: params.messageActionReference } : {}),
      expectedContributorOccurrenceId: contributorOccurrenceId,
      ...(params.context.defaultSessionId === undefined ? {} : { defaultSessionId: params.context.defaultSessionId }),
      ...(params.requiredDangerLevel === undefined ? {} : { requiredDangerLevel: params.requiredDangerLevel }),
    });
    if (!request.success) {
      return { matched: true, result: actionHandlerNotStartedFailure('plugin_action_input_invalid', 'Client Action request is invalid') };
    }
    return { matched: true, result: await runtimeRegistry.executeClientAction(request.data, {
      ...(params.context.signal ? { signal: params.context.signal } : {}),
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
      const managedCustody = await checkManagedCustody();
      if (managedCustody !== null) return managedCustody;
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
    const beforeDemandCurrentness = await checkAdmittedCurrentness();
    if (beforeDemandCurrentness !== null) {
      return { matched: true, result: beforeDemandCurrentness };
    }
    if (!targetActionInvocations.has(pluginId, action.definition.id)) {
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
        );
      }
      const afterActivationCurrentness = await checkAdmittedCurrentness();
      if (afterActivationCurrentness !== null) {
        return { matched: true, result: afterActivationCurrentness };
      }
      if (activationFailure) {
        return { matched: true, result: activationFailure };
      }
    }
    if (!targetActionInvocations.has(pluginId, action.definition.id)) {
      return {
        matched: true,
        result: actionHandlerNotStartedFailure(
          'plugin_action_handler_missing',
          'Declared target action did not publish a committed generation handler',
        ),
      };
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
    // Repeat the admission fence after every await above (demand activation, execution
    // origin, replay placement) and immediately before the target registry
    // admits the handler. The registry's post-approval re-check covers the
    // only later await on user input.
    const beforeHandlerCurrentness = await checkAdmittedCurrentness();
    if (beforeHandlerCurrentness !== null) {
      return { matched: true, result: beforeHandlerCurrentness };
    }
    const validatedInput = admittedTargetedOperation === undefined
      ? null
      : validateTargetedOperationInput(admittedTargetedOperation.targetProtocol, params.input);
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
    let revalidateRequesterDecision: (() => Promise<boolean>) | undefined;
    const sharedRequester = params.approvalContext !== undefined && isSharedRequesterActionV1(params.approvalContext);
    const requestCurrentIntent = params.requestCurrentIntent
      ? async (request: TargetActionCurrentIntentRequest): Promise<TargetActionCurrentIntentResult> => {
          const liveOnly = accountTarget || params.context.approvalInputCustody === 'live_only';
          const requestedSurface = request.invocationSurface ?? request.surface;
          const deferredSurface = requestedSurface === 'api' || requestedSurface === 'cli'
            || requestedSurface === 'agent' || requestedSurface === 'mcp' ? requestedSurface : null;
          const createsConfidentialApproval = requestedSurface !== 'ui' && requestedSurface !== 'voice'
            && (projectTargetActionApprovalInput(request.action.input, request.action.secretInputPaths ?? [])?.confidentialPaths.length ?? 0) > 0;
          const needsApprovalPlacement = (deferredSurface !== null || createsConfidentialApproval || sharedRequester)
            && pluginActionRequiresPresentUserIntent(request.action, requestedSurface, request.action.input);
          if (!liveOnly && !needsApprovalPlacement) return await params.requestCurrentIntent!(request);
          const projectedInput = projectTargetActionApprovalInput(request.action.input, request.action.secretInputPaths ?? []);
          const retainedInput = { action: { pluginId: request.action.pluginId, localId: request.action.localId },
            input: projectedInput?.input ?? request.action.input };
          const requesterAdmission = resolveApprovalRequesterConfirmationV1({ context: params.approvalContext,
            actionId: 'action.invoke', input: retainedInput, required: sharedRequester });
          if (!requesterAdmission.ok) return { status: 'unavailable', code: requesterAdmission.errorCode };
          const { requesterConfirmation } = requesterAdmission;
          let placement: TargetActionApprovalReplayPlacementV1 | undefined;
          // Live custody retains the admitted source without requiring a daemon replay placement.
          if (!liveOnly) {
            const currentPlacement = await resolveCurrentTargetApprovalReplayPlacement(
              runtimeRegistry,
              pluginId,
              request.signal,
            );
            if (currentPlacement.status !== 'resolved') {
              return {
                status: 'unavailable',
                code: currentPlacement.status === 'aborted'
                  ? 'plugin_action_aborted'
                  : 'plugin_action_execution_origin_unavailable',
              };
            }
            placement = Object.freeze({
              serverId: currentPlacement.placement.serverId,
              machineId: currentPlacement.placement.machineId,
              ...(params.context.defaultSessionId === undefined
                ? {}
                : { defaultSessionId: params.context.defaultSessionId }),
            });
          }
          const originSurface = deferredSurface ?? (requestedSurface === 'plugin' ? 'plugin' : null);
          const executionOriginV1 = (!requesterConfirmation ? params.approvalExecutionOrigin : undefined) ?? (originSurface === null ? null : buildApprovalExecutionOriginV1({
            actionId: 'action.invoke',
            input: requesterConfirmation ? retainedInput : { action: { pluginId: request.action.pluginId, localId: request.action.localId }, input: request.action.input },
            ...(requesterConfirmation ? { requesterConfirmation } : {}),
            context: {
              ...params.approvalContext,
              surface: originSurface,
              actionCaller: params.approvalContext?.actionCaller ?? params.context.initiatingActionCaller ?? { kind: 'host' },
              ...(placement ? { serverId: placement.serverId, executionRunTargetMachineId: placement.machineId } : {}),
              actionRequestId: params.approvalContext?.actionRequestId ?? params.approvalExecutionOrigin?.requestId ?? randomUUID(),
            },
            targetSessionId: placement?.defaultSessionId ?? params.context.defaultSessionId ?? null,
          }));
          if (requesterConfirmation && (!executionOriginV1?.externalActionExecutionAuthorization || !executionOriginV1.externalActionInputSignature)) {
            return { status: 'unavailable', code: 'approval_context_unavailable' };
          }
          const result = await params.requestCurrentIntent!({
            ...request,
            ...(liveOnly ? { approvalInputCustody: 'live_only' } : {}),
            ...(placement ? { replayPlacement: placement } : {}),
            ...(executionOriginV1 ? { executionOriginV1 } : {}),
            ...(requesterConfirmation ? { requesterConfirmation } : {}),
          });
          if (result.status === 'approved') revalidateRequesterDecision = result.revalidateRequesterDecision;
          return result;
        }
      : params.requestCurrentIntent;
    const exactPurposeBindingSubjectId = params.admittedManagedProviderOperation?.exactPurposeBindingSubjectId
      ?? params.admittedConnectedAccountPurposeBinding?.exactPurposeBindingSubjectId;
    const targetInvocation = {
      pluginId,
      localId: action.definition.id,
      input: validatedInput === null ? params.input : validatedInput.value,
      surface: actionSurface,
      invocationSurface,
      invocationAuthority: params.approvalContext?.authority ?? 'account_automation',
      ...(params.approvalContext ? { approvalContext: params.approvalContext } : {}),
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
      ...(params.context.signal ? { signal: params.context.signal } : {}),
      ...(params.context.facts ? { facts: params.context.facts } : {}),
      ...(params.context.operationProgress
        ? { operationProgress: params.context.operationProgress }
        : {}),
      ...(accountTarget || params.admittedManagedProviderOperation || params.admittedConnectedAccountPurposeBinding || params.context.beforeHandlerInvocation || sharedRequester
        ? { beforeHandlerInvocation: async () => {
            const check = async () => {
              const refusal = await checkManagedCustody();
              if (refusal && !refusal.ok) throw new PluginError({ code: refusal.errorCode, message: refusal.error });
            };
            await check();
            if (revalidateRequesterDecision && !await revalidateRequesterDecision()) {
              throw new PluginError({ code: 'approval_stale', message: 'approval_stale' });
            }
            if (params.context.beforeHandlerInvocation) {
              await params.context.beforeHandlerInvocation();
              await check();
            }
            // Caller and requester checks may await Home. Re-admit the exact
            // callee release after those reads, immediately before its handler.
            if (accountTarget && await runtimeRegistry.revalidateAccountExecution?.(pluginId, params.context.signal) !== true) {
              throw new PluginError({ code: 'plugin_action_generation_retired', message: 'Account Action source is no longer current' });
            }
          } }
        : {}),
      ...(exactPurposeBindingSubjectId === undefined
        ? {}
        : { exactPurposeBindingSubjectId }),
      ...(params.admittedManagedProviderOperation?.onProcessOutput === undefined
        ? {}
        : { execOutputObserver: params.admittedManagedProviderOperation.onProcessOutput }),
      ...(params.admittedManagedProviderOperation?.execTimeoutMs === undefined
        ? {}
        : { execInvocationTimeoutMs: params.admittedManagedProviderOperation.execTimeoutMs }),
      ...(params.admittedManagedProviderOperation?.readBootstrapCredential
        && isMachineProvisionerBootstrapCredentialRoleV1(params.admittedManagedProviderOperation.role)
        ? { managedBootstrapCredential: {
            role: params.admittedManagedProviderOperation.role,
            readBootstrapCredential: params.admittedManagedProviderOperation.readBootstrapCredential,
            isCurrent: async () => await checkManagedCustody() === null,
          } }
        : {}),
      ...(['acquire', 'rebuild', 'reconcile'].includes(params.admittedManagedProviderOperation?.role ?? '')
        ? { retainHandlerResultAfterCancellation: true as const }
        : {}),
      ...(replayPlacement ? { replayPlacement } : {}),
      ...(params.expectedApprovalReplayPlacement === undefined
        ? {}
        : { requireCurrentIntent: true as const }),
      ...(contributedActionSettingsId === null
        ? {}
        : {
          isEnabledByActionSettings: () => isActionEnabledByActionsSettings(
            contributedActionSettingsId,
            actionSettingsProvider.getActionsSettings(),
            { surface: actionSurface },
          ),
          isApprovalRequiredByActionSettings: (manifestDefault: boolean, parsedInput?: unknown) => isApprovalRequiredByActionsSettings(
            contributedActionSettingsId,
            actionSettingsProvider.getActionsSettings(),
            { surface: actionSurface },
            undefined,
            manifestDefault || sharedRequester && action.definition.dangerLevel === 'writesRemote'
              && pluginActionDeclarationRequiresConfirmationForInput(action.definition, invocationSurface, parsedInput, params.approvalContext?.authority),
          ),
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
      const validatedResult = targetResult.status !== 'executed' || admittedTargetedOperation === undefined
        ? null
        : validateTargetedOperationResult(admittedTargetedOperation.targetProtocol, targetResult.value);
      if (validatedResult !== null && !validatedResult.ok) return validatedResult.result;
      if (targetResult.status === 'executed') {
        // Occurrence fences protect admission before the effect begins, and an
        // ordinary Action's known successful settlement survives later
        // retirement so callers never mistake it for absence and retry blindly.
        // The origin-bearing request is a different contract: it publishes the
        // target's execution origin as current transport authority, so the
        // origin is re-read after settlement and returned only when the before,
        // after, and expected origins all agree. The refusal is deliberately
        // post-start and never carries `notStarted`.
        if (beforeExecutionOrigin?.status === 'resolved'
          && requiresExecutionOrigin) {
          const afterExecutionOrigin = await resolveCurrentTargetExecutionOrigin(
            runtimeRegistry,
            pluginId,
            params.context.signal,
          );
          if (afterExecutionOrigin.status !== 'resolved') {
            return {
              ok: false,
              errorCode: 'plugin_action_execution_origin_unavailable',
              error: 'Current target execution origin is unavailable',
            };
          }
          // Origin equality is exact field identity, so an expected origin that
          // already equals the before-origin also equals any equal after-origin.
          // Comparing before/after is the whole three-way agreement.
          if (!arePluginMachineExecutionOriginsEqual(
            beforeExecutionOrigin.origin,
            afterExecutionOrigin.origin,
          )) {
            return {
              ok: false,
              errorCode: 'plugin_action_execution_origin_changed',
              error: 'Target execution origin changed while the contributed Action was running',
            };
          }
          return {
            ok: true,
            result: validatedResult === null ? targetResult.value : validatedResult.value,
            executionOrigin: afterExecutionOrigin.origin,
          };
        }
        return {
          ok: true,
          result: validatedResult === null ? targetResult.value : validatedResult.value,
        };
      }
      const inputFailure = targetResult.status === 'invalid' && targetResult.code === 'plugin_action_input_schema_invalid'
        && targetResult.issues ? actionInputIssueFailure(...targetResult.issues) : null;
      return {
        ok: false,
        errorCode: targetResult.status === 'unavailable'
          ? projectPluginActionUnavailableOutcomeCode(
            targetResult.code,
            targetResult.actionHandlerInvocation,
          )
          : targetResult.code,
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
    if (params.context.capturePreparedInvocation) {
      const prepared = await runTracedExternalActionStage('action.invoke', params.approvalContext?.actionRequestId,
        'contributed.target_prepare', () => targetActionInvocations.prepare(targetInvocation));
      if (prepared.kind === 'settled') {
        return { matched: true, result: await projectTargetResult(prepared.result) };
      }
      params.context.capturePreparedInvocation(Object.freeze({
        run: async (operationProgress) => await projectTargetResult(await runTracedExternalActionStage(
          'action.invoke', params.approvalContext?.actionRequestId, 'contributed.target_run', () => prepared.run({
          ...(operationProgress ? { operationProgress } : {}),
        }))),
      }));
      return { matched: true, result: { ok: true, result: null } };
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
