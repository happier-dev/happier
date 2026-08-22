import {
  createActionExecutor,
  createUnavailableRuntimeActionExecutor,
  ExecutionRunEnsureOrStartRequestSchema,
  ExecutionRunEnsureRequestSchema,
  ExecutionRunActionRequestSchema,
  ExecutionRunGetRequestSchema,
  ExecutionRunListRequestSchema,
  ExecutionRunSendRequestSchema,
  ExecutionRunStartRequestSchema,
  ExecutionRunTurnStreamCancelRequestSchema,
  ExecutionRunTurnStreamReadRequestSchema,
  ExecutionRunTurnStreamStartRequestSchema,
  convertBackendTargetRefV2ToV1,
  normalizeExecutionRunWaitPollIntervalMs,
  normalizeExecutionRunWaitTimeoutMs,
  readExecutionRunStartRunCreation,
  type ActionExecutorDeps,
  type ActionExecuteResult,
  type PluginPermissionGrantRequestActionInputV1,
  isRuntimeActionIdV1,
  type RuntimeActionExecute,
  type RuntimeActionIdV1,
  waitForExecutionRunTerminal,
  withExecutionRunStartFailureDetails,
} from '@happier-dev/protocol';

import { createSimulatorDaemonRuntimeActionExecutor } from '@/daemon/devices/simulator/actions/runtimeActionExecutor';
import { createSimulatorDaemonFeatureGate } from '@/daemon/devices/simulator/featureGate';
import type { SimulatorPreviewRoutes } from '@/daemon/devices/simulator/previewRoutes.types';
import { createBrowserDaemonRuntimeActionExecutor } from '@/daemon/browser/actions/runtimeActionExecutor';
import { createBrowserDaemonFeatureGate } from '@/daemon/browser/featureGate';
import type { BrowserDaemonControlRoutes } from '@/daemon/browser/control/routes';
import type { BrowserContextRoutes } from '@/daemon/browser/context/routes';
import type { BrowserAutomationRoutes } from '@/daemon/browser/automation/routes';
import type { BrowserRecordingRoutes } from '@/daemon/browser/recording/routes';
import { createBrowserRecordingActionRoutes } from '@/daemon/browser/recording/actionRoutes';
import type { BrowserDiagnosticsActionRoutes } from '@/daemon/browser/diagnostics/actionRoutes';
import {
  createBrowserRecordingAttachToComposer,
  type BrowserRecordingComposerAttachInput,
  type BrowserRecordingComposerAttachResult,
} from '@/daemon/browser/recording/attachToComposer';
import {
  createLocalServicesDaemonRuntimeActionExecutor,
  type LocalServicesRuntimeActionRoutes,
} from '@/daemon/local/services/actions/runtimeActionExecutor';
import {
  createPeerMediationObservabilityDaemonRuntimeActionExecutor,
  type DaemonPeerMediationObservabilityRuntimeActionContext,
} from '@/daemon/peer/mediation/observability/runtimeActionExecutor';
import { createLocalServicesDaemonFeatureGate } from '@/daemon/local/services/featureGate';
import {
  resolveExecutionRunIntentPolicy,
  resolveExecutionRunStartBoundedTimeoutMs,
  validateExecutionRunStartIntentPolicy,
  type ExecutionRunPolicy,
} from '@/agent/executionRuns/policy/executionRunPolicy';
import type { ExecutionRunHostBridgeContract } from '@/agent/runtime/bridges/executionRun/executionRunBridgeContract';
import { resolveExecutionRunRuntimeBackendId } from '@/agent/runtime/bridges/executionRun/backendTargets';
import { VoiceAgentError } from '@/agent/voice/agent/VoiceAgentManager';
import { resolveReviewExecutionRunIntentInput } from '@/agent/reviews/resolveReviewExecutionRunIntentInput';
import { resolveCliFeatureDecision } from '@/features/featureDecisionService';
import { fetchServerFeaturesSnapshot, type CliServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import { isActionApprovalRequiredByEnv, isActionEnabledByEnv } from '@/settings/actionsSettings';

import type { RpcActionExecutor } from '../_actionDispatchAdapter';
import type {
  ExecutionRunHostActionCurrentIntentResult,
  ExecutionRunHostActionCurrentIntentSubject,
} from '@/session/actions/approvals/executionRunHostActionCurrentIntent';

export type ExecutionRunRpcApprovalDeps = Pick<
  ActionExecutorDeps,
  | 'approvalsCreate'
  | 'approvalsGet'
  | 'approvalsList'
  | 'approvalsResolveBlockingDecision'
  | 'approvalsUpdate'
  | 'approvalsWaitForDecision'
  | 'reviewCommentAction'
> & Readonly<{
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
type ExecutionRunStartResult =
  | Readonly<{ ok: true; runId: string; callId: string; sidechainId: string }>
  | ExecutionRunRpcFailure;

type ExecutionRunRpcActionDepsParams = Readonly<{
  manager: ExecutionRunHostBridgeContract;
  context: ExecutionRunRpcActionContext;
  policy: ExecutionRunPolicy;
  isExecutionRunsEnabled: () => boolean;
  approvalDeps?: Partial<ExecutionRunRpcApprovalDeps>;
}>;

type ExecutionRunRpcActionContext = Readonly<{
  /** The handler's fixed authoritative scope; null is the daemon detached scope. */
  sessionId: string | null;
  cwd: string;
  serverUrl?: string;
  budgetRegistry?: unknown;
  browserControl?: BrowserDaemonControlRoutes | null;
  browserContext?: BrowserContextRoutes | null;
  browserAutomation?: BrowserAutomationRoutes | null;
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
  resolveAccountSettings?: () => Promise<Record<string, unknown> | null> | Record<string, unknown> | null;
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

export function createExecutionRunRpcActionDeps(params: ExecutionRunRpcActionDepsParams): ActionExecutorDeps {
  const ensureEnabled = (): ExecutionRunRpcFailure | null => params.isExecutionRunsEnabled()
    ? null
    : executionRunsDisabled();
  let cachedServerSnapshot: CliServerFeaturesSnapshot | undefined;
  const unavailableRuntimeActionExecutor = createUnavailableRuntimeActionExecutor();
  // PMS-WIRE read-path: route `peerMediation.observability.*` to an executor over the shared
  // bootstrap-owned store. The server feature gate is read fail-closed from the same cached
  // server-features accessor used by the browser/local-service daemon gates.
  const peerMediationObservabilityRuntimeActionExecutor = params.context.peerMediationObservability
    ? createPeerMediationObservabilityDaemonRuntimeActionExecutor({
        store: params.context.peerMediationObservability.store,
        accountId: params.context.peerMediationObservability.accountId,
        machineId: params.context.peerMediationObservability.machineId,
        featurePayload: () => {
          const snapshot = params.context.getServerFeaturesSnapshot?.() ?? cachedServerSnapshot;
          return snapshot?.status === 'ready' ? snapshot.features : {};
        },
        fallback: unavailableRuntimeActionExecutor,
      })
    : unavailableRuntimeActionExecutor;
  // OWNER-GATE execution chokepoint for the simulator family: same cached synchronous
  // server-features accessor as the browser/local-services gates, so a server-disabled
  // `devices.simulatorPreview` is refused at the daemon execution boundary even when the preview
  // route owner is present.
  const simulatorDaemonFeatureGate = createSimulatorDaemonFeatureGate({
    env: process.env,
    resolveServerFeaturesSnapshot: () => params.context.getServerFeaturesSnapshot?.() ?? cachedServerSnapshot,
  });
  const simulatorRuntimeActionExecutor = params.context.simulatorPreview
    ? createSimulatorDaemonRuntimeActionExecutor({
        routes: params.context.simulatorPreview,
        fallback: peerMediationObservabilityRuntimeActionExecutor,
        featureGate: simulatorDaemonFeatureGate,
      })
    : peerMediationObservabilityRuntimeActionExecutor;
  // OWNER-GATE execution chokepoint for local services: same cached synchronous server-features
  // accessor as the browser gate, so a server-disabled local-service feature is refused at the
  // daemon execution boundary even when its route owner is present.
  const localServicesDaemonFeatureGate = createLocalServicesDaemonFeatureGate({
    env: process.env,
    resolveServerFeaturesSnapshot: () => params.context.getServerFeaturesSnapshot?.() ?? cachedServerSnapshot,
  });
  const localServicesRuntimeActionExecutor = params.context.localServices
    ? createLocalServicesDaemonRuntimeActionExecutor({
        routes: params.context.localServices,
        fallback: simulatorRuntimeActionExecutor,
        featureGate: localServicesDaemonFeatureGate,
      })
    : simulatorRuntimeActionExecutor;
  const browserRecordingAttachToComposer = (
    params.context.browserRecording && params.context.attachBrowserRecordingToComposer
  )
    ? createBrowserRecordingAttachToComposer({
        routes: params.context.browserRecording,
        attachToComposer: params.context.attachBrowserRecordingToComposer,
      })
    : undefined;
  // OWNER-GATE action-execution chokepoint. The gate reuses the daemon's already-cached
  // synchronous server-features accessor (the same one driving the voice gate above) — no fresh
  // fetch. resolveCliFeatureDecision reads the cached snapshot synchronously, so the executor
  // refuses each dispatchable browser family on server-disable even if a route owner is present.
  const browserDaemonFeatureGate = createBrowserDaemonFeatureGate({
    env: process.env,
    resolveServerFeaturesSnapshot: () => params.context.getServerFeaturesSnapshot?.() ?? cachedServerSnapshot,
  });
  // BA-5: the non-attach recording lifecycle (start/stop/cancel/status/listForView/discard/
  // cleanupExpired) routes through the service-backed recording routes that are already threaded
  // into this context. `attachToComposer` keeps its dedicated composer-attach executor above.
  const browserRecordingActionRoutes = params.context.browserRecording
    ? createBrowserRecordingActionRoutes({ routes: params.context.browserRecording })
    : undefined;
  const browserRuntimeActionExecutor = createBrowserDaemonRuntimeActionExecutor({
    ...(params.context.browserControl ? { control: params.context.browserControl } : {}),
    ...(params.context.browserContext ? { context: params.context.browserContext } : {}),
    ...(params.context.browserAutomation ? { automation: params.context.browserAutomation } : {}),
    ...(params.context.browserDiagnostics ? { diagnostics: params.context.browserDiagnostics } : {}),
    ...(browserRecordingActionRoutes ? { recording: browserRecordingActionRoutes } : {}),
    ...(browserRecordingAttachToComposer ? { recordingAttach: browserRecordingAttachToComposer } : {}),
    featureGate: browserDaemonFeatureGate,
    fallback: localServicesRuntimeActionExecutor,
  });
  const browserRuntimeActionExecutorWithGate: RuntimeActionExecute = async (args) => {
    // Refresh the daemon gates' caches from the synchronous accessor before dispatch (no network
    // fetch). The local-services and simulator executors are fallbacks of the browser executor,
    // so their gates must be primed here too for their actions to be evaluated fail-closed.
    await Promise.all([
      browserDaemonFeatureGate.refresh(),
      localServicesDaemonFeatureGate.refresh(),
      simulatorDaemonFeatureGate.refresh(),
    ]);
    return await browserRuntimeActionExecutor(args);
  };
  let actionDeps: ActionExecutorDeps | null = null;
  let runtimeActionExecutorForRunActions: ReturnType<typeof createActionExecutor> | null = null;

  async function executeRuntimeActionFromRunAction(
    actionId: RuntimeActionIdV1,
    input: unknown,
    context: Readonly<{
      defaultSessionId: string;
      serverId?: string | null;
      callerPermissionMode?: string | null;
    }>,
  ): Promise<ActionExecuteResult> {
    if (!actionDeps) {
      return { ok: false, errorCode: 'execution_run_failed', error: 'execution_run_action_executor_unavailable' };
    }
    runtimeActionExecutorForRunActions ??= createActionExecutor(actionDeps);
    return await runtimeActionExecutorForRunActions.execute(actionId, input, {
      defaultSessionId: context.defaultSessionId,
      ...(context.serverId ? { serverId: context.serverId } : {}),
      surface: 'agent',
      placement: null,
      ...(context.callerPermissionMode ? { callerPermissionMode: context.callerPermissionMode } : {}),
    });
  }

  function isAuthoritativeScope(sessionId: string | null): boolean {
    return sessionId === params.context.sessionId;
  }

  function getRunInAuthoritativeScope(runId: string, sessionId: string | null) {
    const run = params.manager.get(runId);
    return run?.sessionId === sessionId ? run : null;
  }

  async function startRun(
    raw: unknown,
    sessionId: string | null,
    actionOptions?: Parameters<ActionExecutorDeps['executionRunStart']>[2],
  ): Promise<ExecutionRunStartResult> {
    const classifyFailure = (
      failure: ExecutionRunRpcFailure,
      runCreation: 'noRunCreated' | 'outcomeUnknown',
    ): ExecutionRunRpcFailure => ({
      ...failure,
      details: withExecutionRunStartFailureDetails(failure.details, runCreation),
    });
    const beforeStart = (failure: ExecutionRunRpcFailure) => classifyFailure(failure, 'noRunCreated');

    if (!isAuthoritativeScope(sessionId)) return beforeStart(executionRunScopeMismatch());
    const disabled = ensureEnabled();
    if (disabled) return beforeStart(disabled);
    const parsed = ExecutionRunStartRequestSchema.safeParse(raw);
    if (!parsed.success) return beforeStart(invalidParams());
    const backendTarget = convertBackendTargetRefV2ToV1(parsed.data.backendTarget);
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
      const serverSnapshot = params.context.getServerFeaturesSnapshot?.() ?? cachedServerSnapshot;
      let featureDecision = resolveCliFeatureDecision({ featureId, env: process.env, serverSnapshot });

      if (
        featureDecision.state === 'unknown'
        && featureDecision.blockedBy === 'server'
        && params.context.serverUrl
      ) {
        cachedServerSnapshot = await fetchServerFeaturesSnapshot({ serverUrl: params.context.serverUrl });
        const nextSnapshot = params.context.getServerFeaturesSnapshot?.() ?? cachedServerSnapshot;
        featureDecision = resolveCliFeatureDecision({ featureId, env: process.env, serverSnapshot: nextSnapshot });
      }

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
    if (!params.context.budgetRegistry) {
      if (
        typeof params.policy.maxConcurrentRuns === 'number'
        && params.manager.getRunningCount() >= params.policy.maxConcurrentRuns
      ) {
        return beforeStart({ ok: false, error: 'Execution run budget exceeded', errorCode: 'execution_run_budget_exceeded' });
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
    if (parentRunId || parentCallId) {
      const parentDepth = parentRunId
        ? getRunInAuthoritativeScope(parentRunId, sessionId)?.depth ?? null
        : params.manager.getDepthByCallId(parentCallId!, sessionId);
      if (typeof parentDepth !== 'number') {
        return beforeStart({ ok: false, error: 'Invalid parent run reference', errorCode: 'execution_run_invalid_action_input' });
      }
      if (parentDepth + 1 > params.policy.maxDepth) {
        return beforeStart({ ok: false, error: 'Run depth exceeded', errorCode: 'run_depth_exceeded' });
      }
    }
    let accountSettings: Record<string, unknown> | null;
    try {
      accountSettings = await params.context.resolveAccountSettings?.() ?? null;
    } catch (error) {
      return beforeStart({
        ok: false,
        error: error instanceof Error ? error.message : 'Execution setup failed',
        errorCode: 'execution_run_failed',
      });
    }

    try {
      const started = await params.manager.start({
        ...(accountSettings ? { accountSettings } : {}),
        ...parsed.data,
        // The outer Action/RPC scope is authoritative; a passthrough field in
        // the nested start request must not select a second scope.
        sessionId,
        backendTarget,
        ...(hasNormalizedReviewIntentInput ? { intentInput: normalizedReviewIntentInput } : {}),
        ...(actionOptions?.causalPermissionAuthority
          ? { causalPermissionAuthority: actionOptions.causalPermissionAuthority }
          : {}),
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
      const rawDetails = error && typeof error === 'object'
        ? (error as { details?: unknown }).details
        : undefined;
      const runCreation = readExecutionRunStartRunCreation(rawDetails);
      const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
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
      if (error instanceof VoiceAgentError) {
        return classifyFailure({
          ok: false,
          error: error.message,
          errorCode: error.code,
          ...(rawDetails !== undefined ? { details: rawDetails } : {}),
        }, runCreation);
      }
      return classifyFailure({
        ok: false,
        error: error instanceof Error ? error.message : 'Execution failed',
        errorCode: 'execution_run_failed',
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
        ? { runId: started.runId, callId: started.callId, sidechainId: started.sidechainId }
        : started;
    },
    executionRunList: async (sessionId, request) => {
      const disabled = ensureEnabled();
      if (disabled) return disabled;
      if (!isAuthoritativeScope(sessionId)) return executionRunScopeMismatch();
      const listRequest = ExecutionRunListRequestSchema.parse(request);
      return { runs: params.manager.listPublicForRequest(listRequest, sessionId) };
    },
    executionRunGet: async (sessionId, request) => {
      const disabled = ensureEnabled();
      if (disabled) return disabled;
      if (!isAuthoritativeScope(sessionId)) return executionRunScopeMismatch();
      const parsed = ExecutionRunGetRequestSchema.parse(request);
      if (!getRunInAuthoritativeScope(parsed.runId, sessionId)) return executionRunNotFound();
      const run = params.manager.getPublic(parsed.runId)!;
      const structuredMeta = parsed.includeStructured ? params.manager.getStructuredMeta(parsed.runId) : null;
      const latestToolResult = params.manager.getLatestToolResult(parsed.runId);
      return {
        run,
        ...(latestToolResult ? { latestToolResult } : {}),
        ...(structuredMeta ? { structuredMeta } : {}),
      };
    },
    executionRunSend: async (sessionId, request) => {
      const disabled = ensureEnabled();
      if (disabled) return disabled;
      if (!isAuthoritativeScope(sessionId)) return executionRunScopeMismatch();
      const parsed = ExecutionRunSendRequestSchema.parse(request);
      if (!getRunInAuthoritativeScope(parsed.runId, sessionId)) return executionRunNotFound();
      const sent = await params.manager.send(parsed.runId, {
        message: parsed.message,
        resume: parsed.resume,
        delivery: parsed.delivery,
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
    executionRunEnsure: async (sessionId, request) => {
      const disabled = ensureEnabled();
      if (disabled) return disabled;
      if (!isAuthoritativeScope(sessionId)) return executionRunScopeMismatch();
      const parsed = ExecutionRunEnsureRequestSchema.parse(request);
      if (!getRunInAuthoritativeScope(parsed.runId, sessionId)) return executionRunNotFound();
      const ensured = await params.manager.ensure(parsed.runId, { resume: parsed.resume });
      if (!ensured.ok) {
        return {
          ok: false,
          error: ensured.error ?? 'Ensure failed',
          ...(ensured.errorCode ? { errorCode: ensured.errorCode } : {}),
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
        if (!getRunInAuthoritativeScope(runId, sessionId)) return executionRunNotFound();
        const ensured = await params.manager.ensure(runId, { resume: parsed.resume });
        if (!ensured.ok) {
          return {
            ok: false,
            error: ensured.error ?? 'Ensure failed',
            ...(ensured.errorCode ? { errorCode: ensured.errorCode } : {}),
          };
        }
        return { ok: true, runId, created: false };
      }

      const started = await startRun(parsed.start, sessionId, actionOptions);
      if (!started.ok) return started;
      return { ok: true, runId: started.runId, created: true };
    },
    executionRunStreamStart: async (sessionId, request) => {
      const disabled = ensureEnabled();
      if (disabled) return disabled;
      if (!isAuthoritativeScope(sessionId)) return executionRunScopeMismatch();
      const parsed = ExecutionRunTurnStreamStartRequestSchema.parse(request);
      if (!getRunInAuthoritativeScope(parsed.runId, sessionId)) return executionRunNotFound();
      const started = await params.manager.startTurnStream(parsed.runId, {
        message: parsed.message,
        ...(typeof parsed.displayMessage === 'string' ? { displayMessage: parsed.displayMessage } : {}),
        resume: parsed.resume,
      });
      if (!started.ok) {
        return { ok: false, error: started.error, errorCode: started.errorCode };
      }
      return { streamId: started.streamId };
    },
    executionRunStreamRead: async (sessionId, request) => {
      const disabled = ensureEnabled();
      if (disabled) return disabled;
      if (!isAuthoritativeScope(sessionId)) return executionRunScopeMismatch();
      const parsed = ExecutionRunTurnStreamReadRequestSchema.parse(request);
      if (!getRunInAuthoritativeScope(parsed.runId, sessionId)) return executionRunNotFound();
      const read = await params.manager.readTurnStream(parsed.runId, {
        streamId: parsed.streamId,
        cursor: parsed.cursor,
        maxEvents: parsed.maxEvents,
      });
      if (!read.ok) {
        return { ok: false, error: read.error, errorCode: read.errorCode };
      }
      return { streamId: read.streamId, events: read.events, nextCursor: read.nextCursor, done: read.done };
    },
    executionRunStreamCancel: async (sessionId, request) => {
      const disabled = ensureEnabled();
      if (disabled) return disabled;
      if (!isAuthoritativeScope(sessionId)) return executionRunScopeMismatch();
      const parsed = ExecutionRunTurnStreamCancelRequestSchema.parse(request);
      if (!getRunInAuthoritativeScope(parsed.runId, sessionId)) return executionRunNotFound();
      const cancelled = await params.manager.cancelTurnStream(parsed.runId, { streamId: parsed.streamId });
      if (!cancelled.ok) {
        return { ok: false, error: cancelled.error, errorCode: cancelled.errorCode };
      }
      return { ok: true };
    },
    executionRunStop: async (sessionId, request) => {
      const disabled = ensureEnabled();
      if (disabled) return disabled;
      if (!isAuthoritativeScope(sessionId)) return executionRunScopeMismatch();
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
      const parsed = ExecutionRunActionRequestSchema.parse(request);
      const runState = getRunInAuthoritativeScope(parsed.runId, sessionId);
      if (!runState) return executionRunNotFound();
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
            callerPermissionMode: runState.permissionMode,
          },
        ));
      }
      const acted = await params.manager.applyAction(parsed.runId, {
        actionId: parsed.actionId,
        input: parsed.input,
      });
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

      const runId = typeof request.runId === 'string' ? request.runId.trim() : '';
      if (!runId) return invalidParams();

      // Start-and-wait has already admitted exactly one run. Reuse the shared
      // observer with this daemon's fixed scope; it only reads that run and
      // never retries, stops, or retargets it when observation is interrupted.
      return await waitForExecutionRunTerminal({
        runId,
        timeoutMs: normalizeExecutionRunWaitTimeoutMs(request.timeoutSeconds),
        pollIntervalMs: normalizeExecutionRunWaitPollIntervalMs(request.pollIntervalMs),
        ...(opts?.signal ? { signal: opts.signal } : {}),
        readRun: async ({ runId: observedRunId }) => {
          if (!getRunInAuthoritativeScope(observedRunId, sessionId)) {
            return { ok: false, code: 'execution_run_not_found', message: 'Not found' } as const;
          }
          const run = params.manager.getPublic(observedRunId);
          return run
            ? { ok: true, data: { run } } as const
            : { ok: false, code: 'execution_run_not_found', message: 'Not found' } as const;
        },
      });
    },
    runtimeActionExecute: browserRuntimeActionExecutorWithGate,

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
    sessionList: unsupportedActionDependency,
    sessionActivityGet: unsupportedActionDependency,
    sessionRecentMessagesGet: unsupportedActionDependency,

    resetGlobalVoiceAgent: unsupportedActionDependency,

    daemonMemorySearch: unsupportedActionDependency,
    daemonMemoryGetWindow: unsupportedActionDependency,
    daemonMemoryEnsureUpToDate: unsupportedActionDependency,

    ...(params.approvalDeps ?? {}),

    isActionEnabled: (id, ctx) => isActionEnabledByEnv(id, {
      surface: ctx.surface ?? null,
      placement: ctx.placement ?? null,
    }),
    isActionApprovalRequired: (id, ctx) => isActionApprovalRequiredByEnv(id, {
      surface: ctx.surface ?? null,
    }),
  };
  return actionDeps;
}

export function createExecutionRunRpcActionExecutor(
  params: ExecutionRunRpcActionDepsParams,
): RpcActionExecutor {
  return createActionExecutor(createExecutionRunRpcActionDeps(params));
}
