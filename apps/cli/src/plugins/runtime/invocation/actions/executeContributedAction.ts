import {
  ACTION_IDS,
  formatQualifiedPluginActionId,
  type ActionId,
  type QualifiedPluginActionId,
} from '@happier-dev/protocol/actions';
import {
  projectPluginActionUnavailableOutcomeCode,
  type JsonValue,
  type MessageActionAvailableSnapshotV1,
  type PluginMachineExecutionOriginV1,
  type RehydratedPluginContributionPointOperationV1,
  type TargetActionApprovalReplayPlacementV1,
} from '@happier-dev/protocol';
import { arePluginMachineExecutionOriginsEqual } from '@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1';
import type { PluginUiSelectedActionInputCarrierV1 } from '@happier-dev/protocol/plugins/ui';
import type {
  PluginInvocationCaller,
  PluginInvocationOriginSurface,
} from '@happier-dev/plugin-sdk';
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
import {
  isActionEnabledByActionsSettings,
  isApprovalRequiredByActionsSettings,
} from '@happier-dev/protocol/actions';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';

export type PluginActionExecutorResult = Readonly<
  | {
    ok: true;
    result: JsonValue | null;
    /** Host-private handoff from API current-intent admission to Action ingress. */
    deferredApprovalArtifactId?: string;
    /** Present only for the contributed-Action execution-origin request. */
    executionOrigin?: PluginMachineExecutionOriginV1;
  }
  | {
    ok: false;
    errorCode: string;
    error: string;
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
    immutableGenerationId: string;
  }>;
  contributorImmutableGenerationId: string;
  targetProtocol: RehydratedPluginContributionPointOperationV1;
}>;

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
    if (!origin || origin.materializationRef.pluginId !== pluginId) {
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
 * A targeted-contribution admission binds the contributor's exact committed
 * immutable generation. That identity exists before demand activation, unlike
 * a real runtime materialization. When the admitted execution context has a
 * real materialization too, it remains an additional post-activation fence;
 * no caller may synthesize one for a cold bundled contributor.
 */
async function isExpectedPluginCurrent(params: Readonly<{
  runtimeRegistry: ResolvedExecutablePluginRuntimeRegistry | null;
  pluginId: string;
  expectedImmutableGenerationId: string;
  expectedMaterializationId?: string;
  requireMaterialization: boolean;
}>): Promise<boolean> {
  if (!params.runtimeRegistry) return false;
  try {
    const currentGeneration = await params.runtimeRegistry
      .resolveCurrentPluginImmutableGenerationId?.(params.pluginId);
    if (currentGeneration !== params.expectedImmutableGenerationId) {
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

function admittedContributorGenerationRetired(): PluginActionExecutorResult {
  return actionHandlerNotStartedFailure(
    'plugin_action_generation_retired',
    'Admitted contributor generation is no longer current',
  );
}

function admittedTargetGenerationRetired(): PluginActionExecutorResult {
  return actionHandlerNotStartedFailure(
    'plugin_action_generation_retired',
    'Admitted target generation is no longer current',
  );
}

function admittedTargetedOperationInvalid(): PluginActionExecutorResult {
  return actionHandlerNotStartedFailure(
    'plugin_admitted_targeted_operation_handle_invalid',
    'Admitted targeted operation binding is invalid',
  );
}

function targetedOperationInputInvalid(): PluginActionExecutorResult {
  return actionHandlerNotStartedFailure(
    'plugin_targeted_operation_input_invalid',
    'Targeted operation input does not match the target protocol',
  );
}

function targetedOperationResultInvalid(): PluginActionExecutorResult {
  return {
    ok: false,
    errorCode: 'plugin_targeted_operation_result_invalid',
    error: 'Targeted operation result does not match the target protocol',
  };
}

function validateTargetedOperationInput(
  targetProtocol: RehydratedPluginContributionPointOperationV1,
  input: unknown,
): Readonly<{ ok: true; value: unknown }> | Readonly<{ ok: false; result: PluginActionExecutorResult }> {
  if (targetProtocol.input.kind === 'contributorDefined') {
    return Object.freeze({ ok: true as const, value: input });
  }
  try {
    const parsed = targetProtocol.input.schema.safeParse(input);
    if (parsed.success) return Object.freeze({ ok: true as const, value: parsed.data });
  } catch {
    // Target-owned parser failures reject before a contributor Action starts.
  }
  return Object.freeze({ ok: false as const, result: targetedOperationInputInvalid() });
}

function validateTargetedOperationResult(
  targetProtocol: RehydratedPluginContributionPointOperationV1,
  result: JsonValue | null,
): Readonly<{ ok: true; value: JsonValue }> | Readonly<{ ok: false; result: PluginActionExecutorResult }> {
  try {
    const parsed = targetProtocol.resultSchema.safeParse(result);
    if (parsed.success) return Object.freeze({ ok: true as const, value: parsed.data });
  } catch {
    // Target-owned parser failures cannot expose a contributor Action result.
  }
  return Object.freeze({ ok: false as const, result: targetedOperationResultInvalid() });
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
  const activationResults = await params.registry.activateContributionsOnDemand([{
    pluginId,
    family: 'actions',
    localId: params.action.definition.id,
  }]);
  const diagnostics = activationResults.find((result) => result.pluginId === pluginId)?.diagnostics ?? [];
  const activationFailure = diagnostics.find((diagnostic) => diagnostic.code === 'plugin_activation_failed');
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
  /** Host-private request from ActionsService.executeWithExecutionOrigin only. */
  captureExecutionOrigin?: true;
  /**
   * Host-private placement capture for a deferred API approval. Unlike the
   * public execution-origin result, it never turns a completed direct Action
   * into an origin-change failure after the target handler has run.
   */
  captureApprovalReplayPlacement?: true;
  /** Equality-only precondition from ActionsService.executeWithExecutionOrigin only. */
  expectedExecutionOrigin?: PluginMachineExecutionOriginV1;
  /** Exact daemon placement re-read from a durable API approval subject. */
  expectedApprovalReplayPlacement?: TargetActionApprovalReplayPlacementV1;
  /**
   * Host-stamped targeted-contribution admission fence. It is never Action
   * input, a target selector, or public SDK call option.
   */
  expectedContributorImmutableGenerationId?: string;
  /**
   * Optional only when the host admitted this operation with a real runtime
   * materialization. Cold bundled contributors never manufacture this value.
   */
  expectedContributorMaterializationId?: string;
  /** Opaque target-operation evidence forwarded only by the original handle owner. */
  admittedTargetedOperation?: AdmittedTargetedOperationExecutionRequest;
  requestCurrentIntent?: (request: TargetActionCurrentIntentRequest) => Promise<TargetActionCurrentIntentResult>;
  context: Readonly<{
    defaultSessionId?: string;
    /** Declared target capability surface. */
    surface?: PluginActionSurface;
    /** Actual host invocation origin, never inferred from diagnostic provenance. */
    invocationSurface?: PluginActionSurface;
    /** Diagnostic provenance from the immediate plugin caller, never a policy surface. */
    originSurface?: PluginInvocationOriginSurface;
    /** Host-stamped caller provenance for plugin-to-plugin dispatch. */
    caller?: PluginInvocationCaller;
    /**
     * Request-scoped mounted-caller revalidation from the ingress daemon. The
     * target Action owner consumes it exactly before invoking its handler.
     */
    isMountedCallerCurrent?: () => boolean | Promise<boolean>;
    /** Untrusted transient settlement from the mounted UI ingress only. */
    selectedActionInputCarrier?: PluginUiSelectedActionInputCarrierV1;
    /** Bounded whole-message disclosure stamped by the ingress host. */
    messageAction?: MessageActionAvailableSnapshotV1;
    signal?: AbortSignal;
    facts?: ContributionPolicyFacts;
    operationProgress?: TargetActionOperationProgressPort;
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

  // A contributed Action declares one exact execution target. The daemon is
  // not an alternate route for a client target: the invoking UI process owns
  // its activation and handler lifetime, so reaching this leaf fails closed.
  if (
    typeof action.definition.execution === 'object'
    && action.definition.execution !== null
    && 'target' in action.definition.execution
    && action.definition.execution.target === 'client'
  ) {
    return {
      matched: true,
      result: actionHandlerNotStartedFailure(
        'plugin_action_client_target_unavailable',
        'Client-target actions must execute on the invoking UI client',
      ),
    };
  }

  const surface = params.context.surface ?? 'cli';
  const invocationSurface = params.context.invocationSurface ?? surface;
  const actionSurface = params.context.caller?.kind === 'plugin' || surface === 'background'
    ? 'plugin'
    : surface;
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
  const actionSettingsProvider = createActionSettingsProvider();
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
  const admittedTargetedOperation = params.admittedTargetedOperation;
  const expectedContributorImmutableGenerationId = admittedTargetedOperation === undefined
    ? params.expectedContributorImmutableGenerationId
    : admittedTargetedOperation.contributorImmutableGenerationId;
  const expectedContributorMaterializationId =
    params.expectedContributorMaterializationId;
  if (
    admittedTargetedOperation !== undefined
    && params.expectedContributorImmutableGenerationId !== undefined
    && params.expectedContributorImmutableGenerationId
      !== admittedTargetedOperation.contributorImmutableGenerationId
  ) {
    return { matched: true, result: admittedTargetedOperationInvalid() };
  }
  if (
    expectedContributorMaterializationId !== undefined
    && expectedContributorImmutableGenerationId === undefined
  ) {
    return { matched: true, result: admittedContributorGenerationRetired() };
  }
  if (expectedContributorImmutableGenerationId !== undefined
    && !(await isExpectedPluginCurrent({
      runtimeRegistry,
      pluginId,
      expectedImmutableGenerationId: expectedContributorImmutableGenerationId,
      requireMaterialization: false,
    }))) {
    return { matched: true, result: admittedContributorGenerationRetired() };
  }
  if (admittedTargetedOperation !== undefined) {
    if (!matchesAdmittedTargetedOperation(admittedTargetedOperation, action, params.context.caller)) {
      return { matched: true, result: admittedTargetedOperationInvalid() };
    }
    if (!(await isExpectedPluginCurrent({
      runtimeRegistry,
      pluginId: admittedTargetedOperation.target.pluginId,
      expectedImmutableGenerationId: admittedTargetedOperation.target.immutableGenerationId,
      requireMaterialization: false,
    }))) {
      return { matched: true, result: admittedTargetGenerationRetired() };
    }
  }
  const targetActionInvocations = runtimeRegistry
    ? runtimeRegistry.targetActionInvocations
    : undefined;
  if (runtimeRegistry && targetActionInvocations?.expects(pluginId, action.definition.id)) {
    if (!targetActionInvocations.has(pluginId, action.definition.id)) {
      let activationFailure: PluginActionExecutorResult | null;
      try {
        activationFailure = await activateOwningPluginForAction({
          registry: runtimeRegistry,
          contributes,
          action,
        });
      } catch (error) {
        return {
          matched: true,
          result: actionHandlerNotStartedFailure(
            'plugin_activation_failed',
            projectPluginFailureText(error),
          ),
        };
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
    // Demand activation can await. Revalidate the exact admitted contributor
    // immediately before this registry admits a target handler.
    if (expectedContributorImmutableGenerationId !== undefined
      && !(await isExpectedPluginCurrent({
        runtimeRegistry,
        pluginId,
        expectedImmutableGenerationId: expectedContributorImmutableGenerationId,
        expectedMaterializationId: expectedContributorMaterializationId,
        requireMaterialization: true,
      }))) {
      return { matched: true, result: admittedContributorGenerationRetired() };
    }
    const requiresExecutionOrigin = params.captureExecutionOrigin === true
      || params.expectedExecutionOrigin !== undefined;
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
      && params.expectedExecutionOrigin !== undefined
      && !arePluginMachineExecutionOriginsEqual(
        params.expectedExecutionOrigin,
        beforeExecutionOrigin.origin,
      )) {
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
    if (admittedTargetedOperation !== undefined
      && !(await isExpectedPluginCurrent({
        runtimeRegistry,
        pluginId: admittedTargetedOperation.target.pluginId,
        expectedImmutableGenerationId: admittedTargetedOperation.target.immutableGenerationId,
        requireMaterialization: false,
      }))) {
      return { matched: true, result: admittedTargetGenerationRetired() };
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
    const requestCurrentIntent = params.requestCurrentIntent && params.captureApprovalReplayPlacement === true
      ? async (request: TargetActionCurrentIntentRequest): Promise<TargetActionCurrentIntentResult> => {
          const requestedSurface = request.invocationSurface ?? request.surface;
          const createsDurableApiApproval = requestedSurface === 'api'
            && (request.action.confirmation !== undefined
              || request.action.approvalRequiredByActionSettings === true);
          if (!createsDurableApiApproval) return await params.requestCurrentIntent!(request);
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
          return await params.requestCurrentIntent!({
            ...request,
            replayPlacement: Object.freeze({
              serverId: currentPlacement.placement.serverId,
              machineId: currentPlacement.placement.machineId,
              ...(params.context.defaultSessionId === undefined
                ? {}
                : { defaultSessionId: params.context.defaultSessionId }),
            }),
          });
        }
      : params.requestCurrentIntent;
    const targetInvocation = {
      pluginId,
      localId: action.definition.id,
      input: validatedInput === null ? params.input : validatedInput.value,
      surface: actionSurface,
      invocationSurface,
      ...(caller ? { caller } : {}),
      ...(admittedTargetedOperation === undefined
        ? {}
        : {
          expectedAdmittedTargetGeneration: Object.freeze({
            pluginId: admittedTargetedOperation.target.pluginId,
            immutableGenerationId: admittedTargetedOperation.target.immutableGenerationId,
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
          isApprovalRequiredByActionSettings: () => isApprovalRequiredByActionsSettings(
            contributedActionSettingsId,
            actionSettingsProvider.getActionsSettings(),
            { surface: actionSurface },
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
          result: null,
          deferredApprovalArtifactId: targetResult.artifactId,
        };
      }
      const validatedResult = targetResult.status !== 'executed' || admittedTargetedOperation === undefined
        ? null
        : validateTargetedOperationResult(admittedTargetedOperation.targetProtocol, targetResult.value);
      if (validatedResult !== null && !validatedResult.ok) return validatedResult.result;
      if (targetResult.status === 'executed') {
        // Generation fences protect admission before the effect begins, and an
        // ordinary Action's known successful settlement survives later
        // retirement so callers never mistake it for absence and retry blindly.
        // The origin-bearing request is a different contract: it publishes the
        // target's execution origin as current transport authority, so the
        // origin is re-read after settlement and returned only when the before,
        // after, and expected origins all agree. The refusal is deliberately
        // post-start and never carries `notStarted`.
        if (beforeExecutionOrigin?.status === 'resolved'
          && (params.captureExecutionOrigin === true || params.expectedExecutionOrigin !== undefined)) {
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
      return {
        ok: false,
        errorCode: targetResult.status === 'unavailable'
          ? projectPluginActionUnavailableOutcomeCode(
            targetResult.code,
            targetResult.actionHandlerInvocation,
          )
          : targetResult.code,
        error: targetResult.message,
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
      const prepared = await targetActionInvocations.prepare(targetInvocation);
      if (prepared.kind === 'settled') {
        return { matched: true, result: await projectTargetResult(prepared.result) };
      }
      params.context.capturePreparedInvocation(Object.freeze({
        run: async (operationProgress) => await projectTargetResult(await prepared.run({
          ...(operationProgress ? { operationProgress } : {}),
        })),
      }));
      return { matched: true, result: { ok: true, result: null } };
    }
    const targetResult = await targetActionInvocations.invoke(targetInvocation);
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
