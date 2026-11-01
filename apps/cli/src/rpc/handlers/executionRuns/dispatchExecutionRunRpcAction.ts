import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { readUnexpectedActionErrorDiagnosticV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { isActionEnabledByActionsSettings } from '@happier-dev/protocol/actions/actionSettings';
import { isApprovalRequiredByActionsSettings } from '@happier-dev/protocol/actions/actionApprovalPolicy';
import { ExecutionRunEnsureOrStartRequestSchema, ExecutionRunEnsureRequestSchema, ExecutionRunActionRequestSchema, ExecutionRunSendRequestSchema } from '@happier-dev/protocol/execution/runs/index';
import { ExecutionRunCancelTurnRequestSchema } from '@happier-dev/protocol/execution/runs/cancelTurn';
import { ExecutionRunGetRequestSchema, ExecutionRunListRequestSchema, readExecutionRunStartRunCreation, withExecutionRunStartFailureDetails, ExecutionRunTransportErrorCodeSchema, type ExecutionRunStartFailureDetailsV1 } from '@happier-dev/protocol/execution/runs/responseSchemas';
import { ExecutionRunStartRequestSchema } from '@happier-dev/protocol/execution/runs/startRequest';
import { ExecutionRunTurnStreamCancelRequestSchema, ExecutionRunTurnStreamStartRequestSchema } from '@happier-dev/protocol/execution/runs/streaming';
import { ExecutionRunTurnStreamReadRequestSchema } from '@happier-dev/protocol/execution/runs/runPrimitives';
import { normalizeExecutionRunWaitTimeoutMs, waitForExecutionRunTerminal } from '@happier-dev/protocol/execution/runs/waitForTerminal';
import { ProviderErrorCodeV1Schema } from '@happier-dev/protocol/providers/errors';
import { ScmDiffSummaryErrorCodeSchema } from '@happier-dev/protocol/scm/diffSummary';
import { readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';
import type { ActionExecutorDeps, ActionExecutorContext, ActionExecuteResult, PluginPermissionGrantRequestActionInputV1, RuntimeActionIdV1, SessionInputCausalPermissionAuthorityV1, RequiredSessionTeamCredentialV1 } from '@happier-dev/protocol';
import { isRuntimeActionIdV1 } from '@happier-dev/protocol/actions/actionIds';
import { isAgentStartActionV1 } from '@happier-dev/protocol/actions/executor/agentStartAdmission';
import { AGENT_START_REFUSAL_CODES_V1 } from '@happier-dev/protocol/account/settings/admitAgentStartV1';
import { WorkflowTargetUnavailableReasonV1Schema } from '@happier-dev/protocol/workflows/workflowProgressV1';
import { readRetainedReviewFindings } from '@/agent/reviews/normalize/readRetainedReviewFindings';

import type { SimulatorPreviewRoutes } from '@/daemon/devices/simulator/previewRoutes.types';
import type { BrowserDaemonControlRoutes } from '@/daemon/browser/control/routes';
import type { BrowserContextRoutes } from '@/daemon/browser/context/routes';
import type { BrowserAutomationRoutes } from '@/daemon/browser/automation/routes';
import type { BrowserRecordingRoutes } from '@/daemon/browser/recording/routes';
import type { BrowserDiagnosticsActionRoutes } from '@/daemon/browser/diagnostics/actionRoutes';
import type {
  BrowserRecordingComposerAttachInput,
  BrowserRecordingComposerAttachResult,
} from '@/daemon/browser/recording/attachToComposer';
import type { LocalServicesRuntimeActionRoutes } from '@/daemon/local/services/actions/runtimeActionExecutor';
import type { DaemonPeerMediationObservabilityRuntimeActionContext } from '@/daemon/peer/mediation/observability/runtimeActionExecutor';
import { createDaemonRuntimeActionExecutor, type BrowserUiAutomationRouteOwner } from '@/daemon/runtimeActionExecutor';
import {
  resolveExecutionRunIntentPolicy,
  resolveExecutionRunStartBoundedTimeoutMs,
  validateExecutionRunStartIntentPolicy,
  type ExecutionRunPolicy,
} from '@/agent/executionRuns/policy/executionRunPolicy';
import type { ExecutionRunHostBridgeContract } from '@/agent/runtime/bridges/executionRun/executionRunBridgeContract';
import {
  resolveExecutionRunRuntimeBackendId,
  resolveExecutionRunRuntimeBackendTarget,
} from '@/agent/runtime/bridges/executionRun/backendTargets';
import { VoiceAgentError } from '@/agent/voice/agent/VoiceAgentManager';
import { resolveReviewExecutionRunIntentInput } from '@/agent/reviews/resolveReviewExecutionRunIntentInput';
import { resolveCliFeatureDecision } from '@/features/featureDecisionService';
import { normalizeServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { bindRequesterSessionCredentialScope } from '@/persistence';
import type { CliServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import {
  createActionSettingsProvider,
  type RuntimeActionSettingsProvider,
} from '@/settings/actionsSettingsProvider';
import type { ExecutionRunPermissionRequestStore } from '@/agent/runtime/bridges/executionRun/executionRunPermissionResponseTarget';
import {
  readExecutionRunWorkflowObservationSink,
} from '@/agent/runtime/bridges/executionRun/executionRunWorkflowObservation';
import { readExecutionRunStartPreparationReason } from '@/agent/runtime/bridges/executionRun/errors';

import type { RpcActionExecutor, RpcActionExecutorContext } from '../_actionDispatchAdapter';
import type { ExecutionRunRpcHandlerContext } from './registerExecutionRunRpcHandlers';
import type { ExecutionRunProjectLaunchContext } from '@/agent/runtime/registry/engineRegistryTypes';
import type {
  ExecutionRunHostActionCurrentIntentResult,
  ExecutionRunHostActionCurrentIntentSubject,
} from '@/session/actions/approvals/executionRunHostActionCurrentIntent';
import type { ReviewHostPluginAuthorityReader } from '@/agent/executionRuns/profiles/review/pluginAuthority';

export type ExecutionRunRpcApprovalDeps = Pick<
  ActionExecutorDeps,
  | 'approvalsCreate'
  | 'approvalsGet'
  | 'approvalsList'
  | 'approvalsResolveBlockingDecision'
  | 'approvalsUpdate'
  | 'approvalsWaitForDecision'
  | 'isApprovalExecutionOriginCurrent'
  | 'reviewCommentAction'
> & Readonly<{
  resolveReviewHostPluginAuthority?: ReviewHostPluginAuthorityReader;
  executionRunHostActionCurrentIntent?: (
    subject: ExecutionRunHostActionCurrentIntentSubject,
  ) => Promise<ExecutionRunHostActionCurrentIntentResult>;
  pluginPermissionGrantRequest?: (
    input: PluginPermissionGrantRequestActionInputV1 & Readonly<{ serverId?: string }>,
  ) => Promise<unknown>;
}>;

type ExecutionRunRpcFailure = Readonly<{
  ok: false;
  error: string;
  errorCode: string;
  details?: unknown;
}>;

function executionRunSetupFailure(error: unknown): ExecutionRunRpcFailure {
  const providerCode = ProviderErrorCodeV1Schema.safeParse(
    error && typeof error === 'object' && 'code' in error ? error.code : undefined,
  );
  return {
    ok: false,
    errorCode: providerCode.success ? providerCode.data : 'execution_run_failed',
    error: error instanceof Error ? error.message : providerCode.success ? providerCode.data : 'Execution setup failed',
  };
}

/** Caller input to a Voice run belongs to the present user, not its opener. */
export function admitExecutionRunCallerTurn(
  run: Pick<NonNullable<ReturnType<ExecutionRunHostBridgeContract['get']>>, 'intent'>,
  authority: ActionExecutorContext['authority'],
): ExecutionRunRpcFailure | null {
  return run.intent === 'voice_agent' && authority !== 'present_user'
    ? { ok: false, errorCode: 'execution_run_not_allowed', error: 'Voice turns require present-user authority' }
    : null;
}
/**
 * Grants the Team visibility a Session-owned Run's selected resource requires,
 * through the Session access owner, after the user confirmed it. The Run keeps
 * its own selection; the parent Session's model and binding are never touched.
 */
export type GrantAttachedRunTeamVisibility = (input: Readonly<{
  sessionId: string;
  teamId: string;
  requiredTeamCredential: RequiredSessionTeamCredentialV1;
  signal?: AbortSignal;
}>) => Promise<Readonly<{ ok: true } | ExecutionRunRpcFailure>>;
// The host bridge owns what a started run reports; this dispatcher only marks
// the successful case, so it reads that shape back instead of restating it.
type ExecutionRunStartResult =
  | (Readonly<{ ok: true }> & Awaited<ReturnType<ExecutionRunHostBridgeContract['start']>>)
  | ExecutionRunRpcFailure;

type ExecutionRunRpcActionDepsParams = Readonly<{
  manager: ExecutionRunHostBridgeContract;
  context: ExecutionRunRpcActionContext;
  policy: ExecutionRunPolicy;
  isExecutionRunsEnabled: () => boolean;
  actionsSettingsProvider?: RuntimeActionSettingsProvider;
  approvalDeps?: Partial<ExecutionRunRpcApprovalDeps>;
}>;

type ExecutionRunRpcActionContext = Readonly<{
  projectLaunchContext?: import('@/agent/runtime/registry/engineRegistryTypes').ExecutionRunProjectLaunchContext;
  projectSetupOperation?: import('@/workspaces/projectSetup/projectSetupExecution').ProjectSetupOperationContext;
  /** The handler's fixed authoritative scope; null is the daemon detached scope. */
  sessionId: string | null;
  cwd: string;
  resolveProjectLaunchContext?: (context: RpcActionExecutorContext) => Promise<ExecutionRunProjectLaunchContext | null>;
  serverId?: string;
  serverUrl?: string;
  budgetRegistry?: unknown;
  browserControl?: BrowserDaemonControlRoutes | null;
  browserContext?: BrowserContextRoutes | null;
  browserAutomation?: BrowserAutomationRoutes | null;
  getBrowserUiAutomation?: () => BrowserUiAutomationRouteOwner | null;
  browserDiagnostics?: BrowserDiagnosticsActionRoutes | null;
  browserRecording?: BrowserRecordingRoutes | null;
  // Canonical composer/session-media attach owner for finalized browser recordings. When
  // present, the `browser.recording.attachToComposer` leaf routes the recording's reference-only
  // mediaRef here; absent, the attach leaf stays fail-closed (`browser_recording_route_unavailable`).
  attachBrowserRecordingToComposer?: (
    input: BrowserRecordingComposerAttachInput,
  ) => Promise<BrowserRecordingComposerAttachResult>;
  localServices?: LocalServicesRuntimeActionRoutes | null;
  simulatorPreview?: SimulatorPreviewRoutes | null;
  // PMS-WIRE: the shared peer-mediation observability store + daemon scope, handed across the Api
  // provider bridge from the machine-sync bootstrap (write-path owner) so the read-path executor
  // here returns LIVE flow counters rather than a separate, empty store.
  peerMediationObservability?: DaemonPeerMediationObservabilityRuntimeActionContext | null;
  getServerFeaturesSnapshot?: () => CliServerFeaturesSnapshot | undefined;
  resolveAccountSettings?: ExecutionRunRpcHandlerContext['resolveAccountSettings'];
  /** Session-owned Run listing dependency, injected by the runtime principal owner. */
  sessionList?: ActionExecutorDeps['sessionList'];
  /** Exact target-host role/context owner for a present-user start. */
  resolveAgentStartContext?: ActionExecutorDeps['resolveAgentStartContext'];
  readPromptCredentials?: () => Promise<import('@/persistence').StoredCredentials | null>;
  readRequesterWorkAttributionV1?: () => Promise<import('@/daemon/lifecycle/requesterWorkAttribution').RequesterWorkAttributionV1 | null>;
  /** Session access owner for a Run's consented Team visibility requirement. */
  grantAttachedRunTeamVisibility?: GrantAttachedRunTeamVisibility;
}>;

function executionRunsDisabled(): ExecutionRunRpcFailure {
  return { ok: false, error: 'Execution runs feature disabled', errorCode: 'execution_run_not_allowed' };
}

function invalidParams(): ExecutionRunRpcFailure {
  return { ok: false, error: 'Invalid params', errorCode: 'execution_run_invalid_action_input' };
}

function executionRunNotFound(): ExecutionRunRpcFailure {
  return { ok: false, error: 'Not found', errorCode: 'execution_run_not_found' };
}

function executionRunScopeMismatch(): ExecutionRunRpcFailure {
  return { ok: false, error: 'Execution-run scope does not match this daemon handler', errorCode: 'execution_run_scope_mismatch' };
}

function runtimeActionResultToExecutionRunActionResponse(
  result: ActionExecuteResult,
): Readonly<{ ok: true; result: unknown } | { ok: false; errorCode: string; error: string; details?: unknown }> {
  return result.ok
    ? { ok: true, result: result.result }
    : result;
}

function readParentRef(raw: unknown, key: 'parentRunId' | 'parentCallId'): string {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return '';
  }
  const value = (raw as Record<string, unknown>)[key];
  return typeof value === 'string' ? value.trim() : '';
}

async function unsupportedActionDependency(): Promise<never> {
  throw new Error('action_not_supported_in_execution_run_rpc');
}

// Detached execution-run hosts admit no Session corpus, so `session.list` fails with the
// canonical typed SessionListActionResult failure instead of a thrown generic action error.
async function unsupportedSessionListDependency(): Promise<Readonly<{
  ok: false;
  errorCode: 'unsupported_action';
  error: 'unsupported_action:session.list';
}>> {
  return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.list' };
}

function readPermissionRequestStore(value: unknown): ExecutionRunPermissionRequestStore | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.publishRequest === 'function'
    && typeof candidate.publishRequestAndWait === 'function'
    && typeof candidate.registerResponseTargetHandler === 'function'
    ? value as ExecutionRunPermissionRequestStore
    : null;
}

export function createExecutionRunRpcActionDeps(params: ExecutionRunRpcActionDepsParams): ActionExecutorDeps {
  const actionsSettingsProvider = params.actionsSettingsProvider ?? createActionSettingsProvider();
  const ensureEnabled = (): ExecutionRunRpcFailure | null => params.isExecutionRunsEnabled()
    ? null
    : executionRunsDisabled();
  // One daemon composition owner serves execution-run actions and plugin API actions. This adapter
  // contributes the execution-run's routes, current UI owner and cached server-feature accessor.
  const runtimeActionExecute = createDaemonRuntimeActionExecutor({
    env: process.env,
    resolveRouteOwners: () => ({
      ...params.context,
      browserUiAutomation: params.context.getBrowserUiAutomation?.() ?? null,
    }),
    resolveServerFeaturesSnapshot: () => params.context.getServerFeaturesSnapshot?.(),
  });
  let actionDeps: ActionExecutorDeps | null = null;
  let runtimeActionExecutorForRunActions: ReturnType<typeof createActionExecutor> | null = null;

  async function executeRuntimeActionFromRunAction(
    actionId: RuntimeActionIdV1,
    input: unknown,
    context: Readonly<{
      defaultSessionId: string;
      serverId?: string | null;
      authority?: ActionExecutorContext['authority'];
      actionCaller?: ActionExecutorContext['actionCaller'];
      runtimeAccountId?: string;
      runtimeRunId?: string;
      actionRequestId?: string;
      externalActionCredential?: ActionExecutorContext['externalActionCredential'];
      externalActionExecutionAuthorization?: ActionExecutorContext['externalActionExecutionAuthorization'];
      signExternalActionApprovalInput?: ActionExecutorContext['signExternalActionApprovalInput'];
      externalActionTarget?: ActionExecutorContext['externalActionTarget'];
      defaultSessionMachineId?: string;
      callerPermissionMode?: string | null;
      causalPermissionAuthority?: SessionInputCausalPermissionAuthorityV1;
    }>,
  ): Promise<ActionExecuteResult> {
    if (!actionDeps) {
      return { ok: false, errorCode: 'execution_run_failed', error: 'execution_run_action_executor_unavailable' };
    }
    runtimeActionExecutorForRunActions ??= createActionExecutor(actionDeps);
    return await runtimeActionExecutorForRunActions.execute(actionId, input, {
      defaultSessionId: context.defaultSessionId,
      ...(context.serverId ? { serverId: context.serverId } : {}),
      ...(context.authority ? { authority: context.authority } : {}),
      ...(context.actionCaller ? { actionCaller: context.actionCaller } : {}),
      ...(context.runtimeAccountId ? { runtimeAccountId: context.runtimeAccountId } : {}),
      ...(context.runtimeRunId ? { runtimeRunId: context.runtimeRunId } : {}),
      ...(context.actionRequestId ? { actionRequestId: context.actionRequestId } : {}),
      ...(context.externalActionCredential ? { externalActionCredential: context.externalActionCredential } : {}),
      ...(context.externalActionExecutionAuthorization
        ? { externalActionExecutionAuthorization: context.externalActionExecutionAuthorization }
        : {}),
      ...(context.signExternalActionApprovalInput
        ? { signExternalActionApprovalInput: context.signExternalActionApprovalInput }
        : {}),
      ...(context.externalActionTarget ? { externalActionTarget: context.externalActionTarget } : {}),
      ...(context.defaultSessionMachineId ? { defaultSessionMachineId: context.defaultSessionMachineId } : {}),
      surface: 'agent',
      authority: context.authority ?? 'account_automation',
      sessionListAccess: 'current_session',
      placement: null,
      ...(context.callerPermissionMode ? { callerPermissionMode: context.callerPermissionMode } : {}),
      ...(context.causalPermissionAuthority
        ? { causalPermissionAuthority: context.causalPermissionAuthority }
        : {}),
    });
  }

  function isAuthoritativeScope(sessionId: string | null): boolean {
    return sessionId === params.context.sessionId;
  }

  function getRunInAuthoritativeScope(runId: string, sessionId: string | null) {
    const run = params.manager.get(runId);
    return run?.sessionId === sessionId ? run : null;
  }

  function projectExecutionRunGetResponse(runId: string, includeStructured: boolean, includeLatestToolResult = true) {
    const run = params.manager.getPublic(runId);
    const runState = params.manager.get(runId);
    if (!run || !runState) return null;
    const hasLatestToolResult = Object.prototype.hasOwnProperty.call(runState, 'latestToolResult');
    const structuredMeta = includeStructured ? params.manager.getStructuredMeta(runId) : null;
    const reviewFindings = includeStructured ? readRetainedReviewFindings(runState) : null;
    return {
      run,
      ...(hasLatestToolResult && includeLatestToolResult ? { latestToolResult: params.manager.getLatestToolResult(runId) } : {}),
      ...(structuredMeta !== null ? { structuredMeta } : {}),
      ...(reviewFindings !== null ? { reviewFindings } : {}),
    };
  }

  async function startRun(
    raw: unknown,
    sessionId: string | null,
    actionOptions?: Parameters<ActionExecutorDeps['executionRunStart']>[2],
  ): Promise<ExecutionRunStartResult> {
    const classifyFailure = (
      failure: ExecutionRunRpcFailure,
      runCreation: 'noRunCreated' | 'outcomeUnknown',
      error?: unknown,
    ): ExecutionRunRpcFailure => ({
      ...failure,
      details: withExecutionRunStartFailureDetails(failure.details, runCreation,
        error === undefined ? undefined : readUnexpectedActionErrorDiagnosticV1(error).errorClass),
    });
    const beforeStart = (failure: ExecutionRunRpcFailure, error?: unknown) => classifyFailure(failure, 'noRunCreated', error);

    if (!isAuthoritativeScope(sessionId)) return beforeStart(executionRunScopeMismatch());
    const disabled = ensureEnabled();
    if (disabled) return beforeStart(disabled);
    // Request-bound recovery belongs to the manager's identity lookup.
    const parsed = ExecutionRunStartRequestSchema.safeParse(raw);
    if (!parsed.success) return beforeStart(invalidParams());
    if (
      parsed.data.initialInput?.kind === 'deferred_session_pending'
      && (sessionId === null || actionOptions?.actionCaller?.kind !== 'workflowRun')
    ) {
      return beforeStart(invalidParams());
    }
    const backendTarget = resolveExecutionRunRuntimeBackendTarget(parsed.data.backendTarget);
    if (!backendTarget) return beforeStart(invalidParams());
    const backendId = resolveExecutionRunRuntimeBackendId(backendTarget);
    let normalizedReviewIntentInput: unknown;
    let hasNormalizedReviewIntentInput = false;
    if (parsed.data.intent === 'review') {
      const reviewInput = resolveReviewExecutionRunIntentInput(parsed.data.intentInput, {
        engineId: backendId,
        instructions: parsed.data.instructions ?? '',
      });
      if (reviewInput.kind === 'invalid') {
        return beforeStart({
          ok: false,
          error: 'Invalid review intentInput; omit it for a default prompt review or provide a valid review start or follow-up payload',
          errorCode: 'execution_run_invalid_action_input',
        });
      }
      if (reviewInput.kind === 'review_start') {
        normalizedReviewIntentInput = reviewInput.input;
        hasNormalizedReviewIntentInput = true;
      }
    }
    const intentPolicy = resolveExecutionRunIntentPolicy(parsed.data.intent);
    if (intentPolicy.requiredFeatureId) {
      const featureId = intentPolicy.requiredFeatureId;
      const serverSnapshot = params.context.getServerFeaturesSnapshot?.();
      const featureDecision = resolveCliFeatureDecision({ featureId, env: process.env, serverSnapshot });

      if (featureDecision.state !== 'enabled') {
        return beforeStart({
          ok: false,
          error: featureId === 'voice' || featureId.startsWith('voice.')
            ? 'Voice feature disabled'
            : 'Feature disabled',
          errorCode: 'execution_run_not_allowed',
          details: {
            featureId,
            blockedBy: featureDecision.blockedBy,
            blockerCode: featureDecision.blockerCode,
          },
        });
      }
    }
    const policyValidation = validateExecutionRunStartIntentPolicy({
      intent: parsed.data.intent,
      permissionMode: parsed.data.permissionMode,
      retentionPolicy: parsed.data.retentionPolicy,
      runClass: parsed.data.runClass,
      ioMode: parsed.data.ioMode,
    });
    if (!policyValidation.ok) {
      return beforeStart(policyValidation);
    }
    if (intentPolicy.startPreflight) {
      const preflight = await intentPolicy.startPreflight({
        backendId,
        intentInput: parsed.data.intentInput,
        cwd: params.context.cwd,
        env: process.env,
      });
      if (!preflight.ok) {
        return beforeStart(preflight);
      }
    }
    if (!params.policy.allowIoModes.has(parsed.data.ioMode)) {
      return beforeStart({ ok: false, error: 'Unsupported ioMode', errorCode: 'execution_run_not_allowed' });
    }

    const parentRunId = readParentRef(raw, 'parentRunId');
    const parentCallId = readParentRef(raw, 'parentCallId');
    let accountSettings: Record<string, unknown> | null;
    try {
      accountSettings = await params.context.resolveAccountSettings?.() ?? null;
    } catch (error) {
      return beforeStart(executionRunSetupFailure(error), error);
    }

    try {
      const permissionRequestStore = readPermissionRequestStore(actionOptions?.permissionRequestStore);
      if (actionOptions?.permissionRequestStore !== undefined && !permissionRequestStore) {
        return beforeStart(invalidParams());
      }
      const workflowObservationSink = readExecutionRunWorkflowObservationSink(
        actionOptions?.workflowObservationSink,
      );
      if (actionOptions?.workflowObservationSink !== undefined && !workflowObservationSink) {
        return beforeStart(invalidParams());
      }
      if (workflowObservationSink && !parsed.data.localInputId) {
        return beforeStart(invalidParams());
      }
      if (parsed.data.teamCredentialSessionBindingConsent?.sessionId !== undefined
          && parsed.data.teamCredentialSessionBindingConsent.sessionId !== sessionId) {
        return beforeStart(invalidParams());
      }
      // The Run's Team selection is its own binding (`PLAN.md` §2.3): it travels
      // with the Run to its broker open and is never committed to the parent
      // Session. Only a Team-visibility requirement the user confirmed touches
      // the parent, and only its access, through the Session access owner.
      const consent = parsed.data.teamCredentialSessionBindingConsent;
      if (sessionId !== null && parsed.data.teamCredentialModel && consent) {
        const grantVisibility = params.context.grantAttachedRunTeamVisibility;
        if (!grantVisibility) {
          return beforeStart({
            ok: false,
            error: 'Session access owner is unavailable',
            errorCode: 'execution_run_team_session_binding_unavailable',
          });
        }
        let granted: Awaited<ReturnType<GrantAttachedRunTeamVisibility>>;
        try {
          granted = await grantVisibility({
            sessionId, teamId: consent.teamId,
            ...(actionOptions?.signal ? { signal: actionOptions.signal } : {}),
            requiredTeamCredential: {
              resourceId: parsed.data.teamCredentialModel.resourceId,
              expectedResourceRevision: parsed.data.teamCredentialModel.expectedResourceRevision,
              deliveryMode: parsed.data.teamCredentialModel.deliveryMode,
            },
          });
        } catch (error) {
          return beforeStart({
            ok: false,
            error: error instanceof Error ? error.message : 'Team visibility grant failed',
            errorCode: 'execution_run_team_session_binding_rejected',
          }, error);
        }
        if (!granted.ok) return beforeStart(granted);
      }
      const {
        teamCredentialSessionBindingConsent: _teamCredentialSessionBindingConsent,
        // Nonsecret custody facts are still host-only. A passthrough public
        // request must not acquire identity merely by naming the internal field.
        actionRequestId: _callerActionRequestId,
        requesterWorkAttributionV1: _callerAttribution,
        projectLaunchContext: _callerProjectLaunchContext,
        projectSetupOperation: _callerProjectSetupOperation,
        runReportPolicy: _callerRunReportPolicy,
        ...runStartRequest
      } = parsed.data;
      const requesterWorkAttributionV1 = params.context.sessionId === sessionId
        && params.context.readRequesterWorkAttributionV1
        ? await params.context.readRequesterWorkAttributionV1()
        : actionOptions?.requesterWorkAttributionV1;
      let promptCredentials = (sessionId !== null || parsed.data.roleId || parsed.data.intent === 'review')
        ? await params.context.readPromptCredentials?.() ?? undefined
        : undefined;
      if (sessionId !== null && promptCredentials && !promptCredentials.requesterSessionCredentialScope) {
        // Ordinary Session credentials also need their captured Home. Missing
        // custody stays unavailable; memory preparation must not select ambient state.
        promptCredentials = params.context.serverId && params.context.serverUrl
          ? bindRequesterSessionCredentialScope({ ...promptCredentials }, {
            serverId: params.context.serverId,
            serverHttpBaseUrl: normalizeServerHttpBaseUrl(params.context.serverUrl),
          })
          : undefined;
      }
      const started = await params.manager.start({
        ...runStartRequest,
        signal: parsed.data.intent === 'voice_agent' ? actionOptions?.signal : undefined,
        ...(params.context.projectLaunchContext ? { projectLaunchContext: params.context.projectLaunchContext } : {}),
        ...(params.context.projectSetupOperation ? { projectSetupOperation: params.context.projectSetupOperation } : {}),
        accountSettings,
        ...(requesterWorkAttributionV1 ? { requesterWorkAttributionV1 } : {}),
        // The accepted Action context supplies role content and write policy;
        // the public request carries identity only.
        resolvedRole: parsed.data.roleId ? actionOptions?.agentStartContext?.roles[parsed.data.roleId] : undefined,
        promptCredentials,
        workspaceWrites: actionOptions?.workspaceWrites,
        workDepth: actionOptions?.workDepth ?? 0,
        // The outer Action/RPC scope is authoritative; a passthrough field in
        // the nested start request must not select a second scope.
        sessionId,
        backendTarget,
        ...(hasNormalizedReviewIntentInput ? { intentInput: normalizedReviewIntentInput } : {}),
        ...(actionOptions?.causalPermissionAuthority
          ? { causalPermissionAuthority: actionOptions.causalPermissionAuthority }
          : {}),
        ...(actionOptions?.actionCaller?.kind === 'workflowRun' && actionOptions.actionRequestId
          ? { actionRequestId: actionOptions.actionRequestId }
          : {}),
        ...(permissionRequestStore
          ? { getPermissionRequestStore: () => permissionRequestStore }
          : {}),
        ...(workflowObservationSink ? { workflowObservationSink } : {}),
        // Explicitly replace any passthrough request field with host-only proof.
        workflowRunId: actionOptions?.workflowRunId,
        workflowScope: actionOptions?.workflowScope,
        ...(() => {
          const boundedTimeoutMs = resolveExecutionRunStartBoundedTimeoutMs({
            policy: params.policy,
            intent: parsed.data.intent,
          });
          return typeof boundedTimeoutMs === 'number' ? { boundedTimeoutMs } : {};
        })(),
        ...(parentRunId ? { parentRunId } : {}),
        ...(parentCallId ? { parentCallId } : {}),
      });
      return { ok: true, ...started };
    } catch (error) {
      const errorDetails = error && typeof error === 'object'
        ? (error as { details?: unknown }).details
        : undefined;
      const rawDetails = withExecutionRunStartFailureDetails(errorDetails,
        readExecutionRunStartRunCreation(errorDetails), readUnexpectedActionErrorDiagnosticV1(error).errorClass);
      const runCreation = readExecutionRunStartRunCreation(rawDetails);
      const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
      if (typeof code === 'string' && (AGENT_START_REFUSAL_CODES_V1 as readonly string[]).includes(code)) {
        return classifyFailure({ ok: false, errorCode: code, error: code,
          ...(rawDetails !== undefined ? { details: rawDetails } : {}) }, runCreation);
      }
      if (code === 'execution_run_budget_exceeded') {
        return classifyFailure({
          ok: false,
          error: 'Execution run budget exceeded',
          errorCode: 'execution_run_budget_exceeded',
          ...(rawDetails !== undefined ? { details: rawDetails } : {}),
        }, runCreation);
      }
      if (code === 'execution_run_not_allowed') {
        return classifyFailure({
          ok: false,
          error: error instanceof Error ? error.message : 'Execution run is not allowed in this scope',
          errorCode: 'execution_run_not_allowed',
          ...(rawDetails !== undefined ? { details: rawDetails } : {}),
        }, runCreation);
      }
      const providerErrorCode = ProviderErrorCodeV1Schema.safeParse(code);
      if (providerErrorCode.success) {
        return classifyFailure({
          ok: false,
          error: error instanceof Error ? error.message : 'Provider launch failed',
          errorCode: providerErrorCode.data,
          ...(rawDetails !== undefined ? { details: rawDetails } : {}),
        }, runCreation);
      }
      if (error instanceof VoiceAgentError) {
        return classifyFailure({
          ok: false,
          error: error.message,
          errorCode: error.code,
          ...(rawDetails !== undefined ? { details: rawDetails } : {}),
        }, runCreation);
      }
      const transportCode = ExecutionRunTransportErrorCodeSchema.safeParse(code);
      const scmErrorCode = ScmDiffSummaryErrorCodeSchema.safeParse(code);
      const refusalCode = scmErrorCode.success ? scmErrorCode.data
        : transportCode.success ? undefined : readRpcErrorCode(error);
      if (refusalCode) {
        return classifyFailure({
          ok: false,
          error: readExecutionRunStartPreparationReason(error) ?? refusalCode,
          errorCode: refusalCode,
          ...(rawDetails !== undefined ? { details: rawDetails } : {}),
        }, runCreation);
      }
      return classifyFailure({
        ok: false,
        error: error instanceof Error ? error.message : 'Execution failed',
        errorCode: transportCode.success ? transportCode.data : 'execution_run_failed',
        ...(rawDetails !== undefined ? { details: rawDetails } : {}),
      }, runCreation);
    }
  }

  actionDeps = {
    // This executor is already running inside the exact V2-capable daemon
    // owner. Remote callers perform exact-machine capability preflight before
    // reaching it; local daemon composition must not recursively probe itself.
    executionRunCheckProtocolV2: async () => ({ ok: true }),
    executionRunStart: async (sessionId, request, actionOptions) => {
      const disabled = ensureEnabled();
      if (disabled) {
        return {
          ...disabled,
          details: withExecutionRunStartFailureDetails(disabled.details, 'noRunCreated'),
        };
      }
      if (!isAuthoritativeScope(sessionId)) {
        const mismatch = executionRunScopeMismatch();
        return {
          ...mismatch,
          details: withExecutionRunStartFailureDetails(mismatch.details, 'noRunCreated'),
        };
      }
      const started = await startRun(request, sessionId, actionOptions);
      return started.ok
        ? {
            runId: started.runId,
            callId: started.callId,
            sidechainId: started.sidechainId,
            ...(started.requestedConfiguration
              ? { requestedConfiguration: started.requestedConfiguration }
              : {}),
            ...(started.preparedInstructionsFor ? { preparedInstructionsFor: started.preparedInstructionsFor } : {}),
          }
        : started;
    },
    executionRunList: async (sessionId, request) => {
      const disabled = ensureEnabled();
      if (disabled) return disabled;
      if (!isAuthoritativeScope(sessionId)) return executionRunScopeMismatch();
      await params.manager.recoverRetainedRuns();
      const listRequest = ExecutionRunListRequestSchema.parse(request);
      return { runs: params.manager.listPublicForRequest(listRequest, sessionId) };
    },
    executionRunGet: async (sessionId, request, opts) => {
      const disabled = ensureEnabled();
      if (disabled) return disabled;
      if (!isAuthoritativeScope(sessionId)) return executionRunScopeMismatch();
      await params.manager.recoverRetainedRuns();
      const parsed = ExecutionRunGetRequestSchema.parse(request);
      if (!getRunInAuthoritativeScope(parsed.runId, sessionId)) return executionRunNotFound();
      opts?.signal?.throwIfAborted();
      if (parsed.waitForInputId && opts?.permissionRequestStore !== undefined) {
        const store = readPermissionRequestStore(opts.permissionRequestStore);
        if (!store || !opts.workflowRunId || !params.manager.rebindWorkflowInputPermissionRequestStore(parsed.runId, {
          workflowRunId: opts.workflowRunId, localInputId: parsed.waitForInputId, store,
        })) return invalidParams();
      }
      if (parsed.waitForOutput) await params.manager.waitForOutput(parsed.runId, parsed.waitForOutput, opts?.signal);
      const observedInputTurn = parsed.waitForInputId
        ? await params.manager.waitForInputTurn(parsed.runId, parsed.waitForInputId, opts?.signal)
        : null;
      const response = projectExecutionRunGetResponse(parsed.runId, parsed.includeStructured === true, parsed.includeLatestToolResult !== false);
      if (!response) return executionRunNotFound();
      if (!observedInputTurn) return response;
      const projectedTurns = response.run.inputTurns;
      return {
        ...response,
        run: {
          ...response.run,
          inputTurns: {
            occurrenceId: observedInputTurn.occurrenceId,
            ...(projectedTurns?.occurrenceId === observedInputTurn.occurrenceId && projectedTurns.current
              ? { current: projectedTurns.current }
              : {}),
            last: observedInputTurn.turn,
          },
        },
      };
    },
    detachedExecutionRunSend: async (sessionId, request, actionOptions) => {
      const disabled = ensureEnabled();
      if (disabled) return disabled;
      if (!isAuthoritativeScope(sessionId)) return executionRunScopeMismatch();
      await params.manager.recoverRetainedRuns();
      const parsed = ExecutionRunSendRequestSchema.parse(request);
      const run = getRunInAuthoritativeScope(parsed.runId, sessionId);
      if (!run) return executionRunNotFound();
      const refusal = admitExecutionRunCallerTurn(run, actionOptions?.authority);
      if (refusal) return refusal;
      const permissionRequestStore = readPermissionRequestStore(actionOptions?.permissionRequestStore);
      if (actionOptions?.permissionRequestStore !== undefined && !permissionRequestStore) {
        return { ok: false, errorCode: 'execution_run_invalid_action_input', error: 'Invalid interaction target' };
      }
      const workflowObservationSink = readExecutionRunWorkflowObservationSink(
        actionOptions?.workflowObservationSink,
      );
      if (actionOptions?.workflowObservationSink !== undefined && !workflowObservationSink) {
        return { ok: false, errorCode: 'execution_run_invalid_action_input', error: 'Invalid Workflow observation target' };
      }
      if (workflowObservationSink && !parsed.localInputId) {
        return { ok: false, errorCode: 'execution_run_invalid_action_input', error: 'Workflow observation requires an exact local input id' };
      }
      const sent = await params.manager.send(parsed.runId, {
        message: parsed.message,
        resume: parsed.resume,
        delivery: parsed.delivery,
        ...(params.context.projectLaunchContext ? { projectLaunchContext: params.context.projectLaunchContext } : {}),
        ...(parsed.localInputId ? { localInputId: parsed.localInputId } : {}),
        ...(parsed.resultContract ? { resultContract: parsed.resultContract } : {}),
        ...(parsed.structuredInput ? { structuredInput: parsed.structuredInput } : {}),
        ...(actionOptions?.causalPermissionAuthority
          ? { causalPermissionAuthority: actionOptions.causalPermissionAuthority }
          : {}),
        ...(actionOptions?.effectiveCallerPermissionMode !== undefined
          ? { effectiveCallerPermissionMode: actionOptions.effectiveCallerPermissionMode }
          : {}),
        ...(actionOptions?.signal ? { signal: actionOptions.signal } : {}),
        ...(permissionRequestStore ? { permissionRequestStore } : {}),
        ...(workflowObservationSink ? { workflowObservationSink } : {}),
      });
      if (!sent.ok) {
        return {
          ok: false,
          error: sent.error ?? 'Send failed',
          errorCode: sent.errorCode ?? 'execution_run_failed',
        };
      }
      return { ok: true };
    },
    executionRunEnsure: async (sessionId, request, actionOptions) => {
      const disabled = ensureEnabled();
      if (disabled) return disabled;
      if (!isAuthoritativeScope(sessionId)) return executionRunScopeMismatch();
      await params.manager.recoverRetainedRuns();
      const parsed = ExecutionRunEnsureRequestSchema.parse(request);
      if (!getRunInAuthoritativeScope(parsed.runId, sessionId)) return executionRunNotFound();
      const ensured = await params.manager.ensure(parsed.runId, {
        resume: parsed.resume,
        ...(actionOptions?.signal ? { signal: actionOptions.signal } : {}),
        ...(params.context.projectLaunchContext ? { projectLaunchContext: params.context.projectLaunchContext } : {}),
        ...(actionOptions?.causalPermissionAuthority
          ? { causalPermissionAuthority: actionOptions.causalPermissionAuthority }
          : {}),
      });
      if (!ensured.ok) {
        return {
          ok: false,
          error: ensured.error ?? 'Ensure failed',
          ...(ensured.errorCode ? { errorCode: ensured.errorCode } : {}),
          ...(ensured.details ? { details: ensured.details } : {}),
        };
      }
      return { ok: true };
    },
    executionRunEnsureOrStart: async (sessionId, request, actionOptions) => {
      const disabled = ensureEnabled();
      if (disabled) return disabled;
      if (!isAuthoritativeScope(sessionId)) return executionRunScopeMismatch();
      const parsed = ExecutionRunEnsureOrStartRequestSchema.parse(request);
      const runId = typeof parsed.runId === 'string' ? parsed.runId.trim() : '';
      if (runId) {
        await params.manager.recoverRetainedRuns();
        if (!getRunInAuthoritativeScope(runId, sessionId)) return executionRunNotFound();
        const ensured = await params.manager.ensure(runId, {
          resume: parsed.resume,
          ...(actionOptions?.signal ? { signal: actionOptions.signal } : {}),
          ...(params.context.projectLaunchContext ? { projectLaunchContext: params.context.projectLaunchContext } : {}),
          ...(actionOptions?.causalPermissionAuthority
            ? { causalPermissionAuthority: actionOptions.causalPermissionAuthority }
            : {}),
        });
        if (!ensured.ok) {
          return {
            ok: false,
            error: ensured.error ?? 'Ensure failed',
            ...(ensured.errorCode ? { errorCode: ensured.errorCode } : {}),
            ...(ensured.details ? { details: ensured.details } : {}),
          };
        }
        return { ok: true, runId, created: false };
      }

      const started = await startRun(parsed.start, sessionId, actionOptions);
      if (!started.ok) return started;
      return { ...started, created: true };
    },
    executionRunStreamStart: async (sessionId, request, actionOptions) => {
      const disabled = ensureEnabled();
      if (disabled) return disabled;
      if (!isAuthoritativeScope(sessionId)) return executionRunScopeMismatch();
      await params.manager.recoverRetainedRuns();
      const parsed = ExecutionRunTurnStreamStartRequestSchema.parse(request);
      const run = getRunInAuthoritativeScope(parsed.runId, sessionId);
      if (!run) return executionRunNotFound();
      const refusal = admitExecutionRunCallerTurn(run, actionOptions?.authority);
      if (refusal) return refusal;
      const started = await params.manager.startTurnStream(parsed.runId, {
        message: parsed.message,
        ...(parsed.speechSegmentTargetChars !== undefined
          ? { speechSegmentTargetChars: parsed.speechSegmentTargetChars }
          : {}),
        ...(typeof parsed.displayMessage === 'string' ? { displayMessage: parsed.displayMessage } : {}),
        resume: parsed.resume,
        ...(actionOptions?.causalPermissionAuthority
          ? { causalPermissionAuthority: actionOptions.causalPermissionAuthority }
          : {}),
      });
      if (!started.ok) {
        return { ok: false, error: started.error, errorCode: started.errorCode };
      }
      return { streamId: started.streamId };
    },
    executionRunStreamRead: async (sessionId, request, actionOptions) => {
      const disabled = ensureEnabled();
      if (disabled) return disabled;
      if (!isAuthoritativeScope(sessionId)) return executionRunScopeMismatch();
      await params.manager.recoverRetainedRuns();
      const parsed = ExecutionRunTurnStreamReadRequestSchema.parse(request);
      if (!getRunInAuthoritativeScope(parsed.runId, sessionId)) return executionRunNotFound();
      const read = await params.manager.readTurnStream(parsed.runId, {
        streamId: parsed.streamId,
        cursor: parsed.cursor,
        maxEvents: parsed.maxEvents,
        waitForEvents: parsed.waitForEvents,
        ...(actionOptions?.signal ? { signal: actionOptions.signal } : {}),
      });
      if (!read.ok) {
        return { ok: false, error: read.error, errorCode: read.errorCode };
      }
      return { streamId: read.streamId, events: read.events, nextCursor: read.nextCursor, done: read.done,
        ...(read.preparedInstructionsFor ? { preparedInstructionsFor: read.preparedInstructionsFor } : {}) };
    },
    executionRunStreamCancel: async (sessionId, request) => {
      const disabled = ensureEnabled();
      if (disabled) return disabled;
      if (!isAuthoritativeScope(sessionId)) return executionRunScopeMismatch();
      await params.manager.recoverRetainedRuns();
      const parsed = ExecutionRunTurnStreamCancelRequestSchema.parse(request);
      if (!getRunInAuthoritativeScope(parsed.runId, sessionId)) return executionRunNotFound();
      const cancelled = await params.manager.cancelTurnStream(parsed.runId, { streamId: parsed.streamId });
      if (!cancelled.ok) {
        return { ok: false, error: cancelled.error, errorCode: cancelled.errorCode };
      }
      return { ok: true };
    },
    executionRunCancelTurn: async (sessionId, request) => {
      const disabled = ensureEnabled();
      if (disabled) return disabled;
      if (!isAuthoritativeScope(sessionId)) return executionRunScopeMismatch();
      await params.manager.recoverRetainedRuns();
      const parsed = ExecutionRunCancelTurnRequestSchema.parse(request);
      if (!getRunInAuthoritativeScope(parsed.runId, sessionId)) return executionRunNotFound();
      return await params.manager.cancelCurrentTurn(parsed.runId, parsed);
    },
    executionRunStop: async (sessionId, request) => {
      const disabled = ensureEnabled();
      if (disabled) return disabled;
      if (!isAuthoritativeScope(sessionId)) return executionRunScopeMismatch();
      await params.manager.recoverRetainedRuns();
      const parsed = ExecutionRunGetRequestSchema.parse(request);
      if (!getRunInAuthoritativeScope(parsed.runId, sessionId)) return executionRunNotFound();
      const stopped = await params.manager.stop(parsed.runId);
      if (!stopped.ok) {
        return {
          ok: false,
          error: stopped.error ?? 'Stop failed',
          errorCode: stopped.errorCode ?? 'execution_run_failed',
        };
      }
      return { ok: true };
    },
    executionRunAction: async (sessionId, request, opts) => {
      const disabled = ensureEnabled();
      if (disabled) return disabled;
      if (!isAuthoritativeScope(sessionId)) return executionRunScopeMismatch();
      await params.manager.recoverRetainedRuns();
      const parsed = ExecutionRunActionRequestSchema.parse(request);
      const runState = getRunInAuthoritativeScope(parsed.runId, sessionId);
      if (!runState && params.manager.get(parsed.runId)) return executionRunScopeMismatch();
      if (!runState && parsed.actionId !== 'review.triage') return executionRunNotFound();
      const refusal = runState ? admitExecutionRunCallerTurn(runState, opts?.authority) : null;
      if (refusal) return refusal;
      if (isRuntimeActionIdV1(parsed.actionId)) {
        if (sessionId === null) {
          return { ok: false, errorCode: 'execution_run_not_allowed', error: 'Runtime actions require a Session scope' };
        }
        return runtimeActionResultToExecutionRunActionResponse(await executeRuntimeActionFromRunAction(
          parsed.actionId,
          parsed.input,
          {
            defaultSessionId: sessionId,
            ...(opts?.serverId ? { serverId: opts.serverId } : {}),
            ...(opts?.authority ? { authority: opts.authority } : {}),
            ...(opts?.actionCaller ? { actionCaller: opts.actionCaller } : {}),
            ...(opts?.runtimeAccountId ? { runtimeAccountId: opts.runtimeAccountId } : {}),
            runtimeRunId: parsed.runId,
            ...(opts?.actionRequestId ? { actionRequestId: opts.actionRequestId } : {}),
            ...(opts?.externalActionCredential ? { externalActionCredential: opts.externalActionCredential } : {}),
            ...(opts?.externalActionExecutionAuthorization
              ? { externalActionExecutionAuthorization: opts.externalActionExecutionAuthorization }
              : {}),
            ...(opts?.signExternalActionApprovalInput
              ? { signExternalActionApprovalInput: opts.signExternalActionApprovalInput }
              : {}),
            ...(opts?.externalActionTarget ? { externalActionTarget: opts.externalActionTarget } : {}),
            ...(opts?.defaultSessionMachineId ? { defaultSessionMachineId: opts.defaultSessionMachineId } : {}),
            ...(opts?.effectiveCallerPermissionMode
              ? { callerPermissionMode: opts.effectiveCallerPermissionMode }
              : {}),
            ...(opts?.causalPermissionAuthority
              ? { causalPermissionAuthority: opts.causalPermissionAuthority }
              : {}),
          },
        ));
      }
      const acted = await params.manager.applyAction(parsed.runId, {
        actionId: parsed.actionId,
        input: parsed.input,
      }, opts?.causalPermissionAuthority || opts?.effectiveCallerPermissionMode
        ? {
            ...(opts?.causalPermissionAuthority
              ? { causalPermissionAuthority: opts.causalPermissionAuthority }
              : {}),
            ...(opts?.effectiveCallerPermissionMode
              ? { effectiveCallerPermissionMode: opts.effectiveCallerPermissionMode }
              : {}),
          }
        : undefined);
      if (!acted.ok) {
        return {
          ok: false,
          error: acted.error ?? 'Unsupported',
          errorCode: acted.errorCode ?? 'execution_run_action_not_supported',
        };
      }
      return {
        ok: true,
        ...(typeof acted.updatedToolResult !== 'undefined' ? { updatedToolResult: acted.updatedToolResult } : {}),
        ...(typeof acted.result !== 'undefined' ? { result: acted.result } : {}),
      };
    },
    executionRunWait: async (sessionId, request, opts) => {
      const disabled = ensureEnabled();
      if (disabled) return disabled;
      if (!isAuthoritativeScope(sessionId)) return executionRunScopeMismatch();
      await params.manager.recoverRetainedRuns();

      const runId = typeof request.runId === 'string' ? request.runId.trim() : '';
      if (!runId) return invalidParams();

      // Start-and-wait has already admitted exactly one run. Reuse the shared
      // observer with this daemon's fixed scope; it only reads that run and
      // never retries, stops, or retargets it when observation is interrupted.
      return await waitForExecutionRunTerminal({
        runId,
        timeoutMs: normalizeExecutionRunWaitTimeoutMs(request.timeoutSeconds),
        ...(request.condition ? { condition: request.condition } : {}),
        ...(request.after ? { after: request.after } : {}),
        ...(opts?.signal ? { signal: opts.signal } : {}),
        waitForTerminal: async (observedRunId, signal) => {
          await params.manager.waitForTerminal(observedRunId, { signal });
        },
        waitForChange: (observedRunId, signal) => params.manager.waitForRunStateChange(observedRunId, signal),
        readRun: async ({ runId: observedRunId }) => {
          if (!getRunInAuthoritativeScope(observedRunId, sessionId)) {
            return { ok: false, code: 'execution_run_not_found', message: 'Not found' } as const;
          }
          const result = projectExecutionRunGetResponse(observedRunId, true);
          return result
            ? { ok: true, data: result } as const
            : { ok: false, code: 'execution_run_not_found', message: 'Not found' } as const;
        },
      });
    },
    runtimeActionExecute,

    sessionOpen: unsupportedActionDependency,
    sessionFork: unsupportedActionDependency,
    sessionRollback: unsupportedActionDependency,
    sessionSpawnNew: unsupportedActionDependency,

    pathsListRecent: unsupportedActionDependency,
    machinesList: unsupportedActionDependency,
    serversList: unsupportedActionDependency,
    reviewEnginesList: unsupportedActionDependency,
    agentsBackendsList: unsupportedActionDependency,
    agentsModelsList: unsupportedActionDependency,

    sessionSendMessage: unsupportedActionDependency,
    sessionModeSet: unsupportedActionDependency,
    sessionModesList: unsupportedActionDependency,

    sessionTargetPrimarySet: unsupportedActionDependency,
    sessionTargetTrackedSet: unsupportedActionDependency,
    sessionList: params.context.sessionId && params.context.sessionList
      ? params.context.sessionList
      : unsupportedSessionListDependency,
    sessionActivityGet: unsupportedActionDependency,
    sessionRecentMessagesGet: unsupportedActionDependency,

    resetGlobalVoiceAgent: unsupportedActionDependency,

    daemonMemorySearch: unsupportedActionDependency,
    daemonMemoryGetWindow: unsupportedActionDependency,
    daemonMemoryEnsureUpToDate: unsupportedActionDependency,

    ...(params.approvalDeps ?? {}),

    isActionEnabled: (id, ctx) => isActionEnabledByActionsSettings(
      id,
      actionsSettingsProvider.getActionsSettings(),
      {
        surface: ctx.surface ?? null,
        placement: ctx.placement ?? null,
      },
    ),
    isActionApprovalRequired: (id, ctx) => isApprovalRequiredByActionsSettings(
      id,
      actionsSettingsProvider.getActionsSettings(),
      {
        surface: ctx.surface ?? null,
        authority: ctx.authority,
        presentUserConfirmation: ctx.presentUserConfirmation,
      },
    ),
  };
  return actionDeps;
}

export function createExecutionRunRpcActionExecutor(
  params: ExecutionRunRpcActionDepsParams,
): RpcActionExecutor {
  const deps = createExecutionRunRpcActionDeps(params);
  const executor = createActionExecutor(deps);
  return {
    execute: async (actionId, input, context) => {
      // Account governance precedes Project custody/preparation. A disabled
      // Action must still report its own policy result without a launch context.
      try {
        await params.context.resolveAccountSettings?.(actionId);
      } catch (error) {
        if (!isAgentStartActionV1(actionId)) throw error;
        return {
          ...executionRunSetupFailure(error),
          details: withExecutionRunStartFailureDetails(undefined, 'noRunCreated',
            readUnexpectedActionErrorDiagnosticV1(error).errorClass),
        };
      }
      if (await deps.isActionEnabled?.(actionId, context ?? {}) === false) return await executor.execute(actionId, input, context);
      const retainedRunId = input && typeof input === 'object' && 'runId' in input
        && typeof input.runId === 'string' ? input.runId.trim() : '';
      const createsRun = actionId === 'execution.run.start'
        || (actionId === 'execution.run.ensure_or_start' && !retainedRunId);
      const resumesRun = (actionId === 'execution.run.ensure' || actionId === 'execution.run.send'
        || actionId === 'execution.run.ensure_or_start')
        && input && typeof input === 'object' && 'resume' in input && input.resume === true;
      const projectSetupOperation = !params.context.projectSetupOperation && context?.signal && context.operationProgress
        && context.operationOwnerUpdate && context.operationAcceptance ? {
          signal: context.signal, actionRequestId: context.actionRequestId ?? undefined, operationProgress: context.operationProgress,
          operationOwnerUpdate: context.operationOwnerUpdate, operationAcceptance: context.operationAcceptance,
          ...(context.operationCancellation ? { operationCancellation: context.operationCancellation } : {}),
          ...(context.operationReview ? { operationReview: context.operationReview } : {}),
        } : undefined;
      if ((createsRun || resumesRun) && (params.context.resolveProjectLaunchContext || projectSetupOperation)) {
        const projectLaunchContext = await params.context.resolveProjectLaunchContext?.(context ?? { surface: 'rpc' });
        if (createsRun && params.context.resolveProjectLaunchContext && !projectLaunchContext) return { ok: false, errorCode: 'project_requester_credentials_unavailable',
          error: 'Project launch requester custody is unavailable', details: withExecutionRunStartFailureDetails(undefined, 'noRunCreated') };
        const { resolveProjectLaunchContext: _resolve, ...captured } = params.context;
        return await createExecutionRunRpcActionExecutor({ ...params, context: { ...captured,
          ...(projectLaunchContext ? { projectLaunchContext } : {}), ...(projectSetupOperation ? { projectSetupOperation } : {}) } })
          .execute(actionId, input, context);
      }
      if (context?.authority === 'present_user' && isAgentStartActionV1(actionId)
        && input && typeof input === 'object' && 'roleId' in input && typeof input.roleId === 'string'
        && !context.agentStartContext) {
        let refusal: NonNullable<ExecutionRunStartFailureDetailsV1['executionRunStart']['refusal']> = {
          code: 'agent_start_context_unavailable', phase: 'agent_start_context',
        };
        let resolved: ActionExecutorContext['agentStartContext'] | null;
        let errorCode = 'target_unavailable';
        try {
          resolved = await params.context.resolveAgentStartContext?.({ ...context,
            recordActionStartDiagnostic: event => {
              if (event.refusalReason) refusal = { code: event.refusalReason, phase: 'agent_start_context' };
              context?.recordActionStartDiagnostic?.(event);
            },
          });
        } catch (error) {
          const code = readRpcErrorCode(error) ?? (error && typeof error === 'object' && 'code' in error ? error.code : undefined);
          const reason = WorkflowTargetUnavailableReasonV1Schema.safeParse(
            code === 'account_role_overrides_unavailable' ? 'role_overrides_unavailable' : code);
          if (!reason.success) throw error;
          refusal = { code: reason.data, phase: 'agent_start_context' };
          errorCode = typeof code === 'string' ? code : 'target_unavailable';
          context.recordActionStartDiagnostic?.({ phase: 'agent_start_context', refusalReason: reason.data });
          resolved = null;
        }
        if (!resolved) return { ok: false, errorCode,
          error: 'The selected role cannot be prepared for this Session. Check its Account and role availability.',
          details: withExecutionRunStartFailureDetails({ executionRunStart: {
            v: 1, runCreation: 'noRunCreated', refusal,
          } }, 'noRunCreated') };
        context = { ...context, agentStartContext: resolved };
      }
      return await executor.execute(actionId, input, context);
    },
  };
}
