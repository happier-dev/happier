import {
  createActionExecutor,
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
  type ActionExecutorDeps,
} from '@happier-dev/protocol';

import {
  resolveExecutionRunIntentPolicy,
  resolveExecutionRunStartBoundedTimeoutMs,
  validateExecutionRunStartIntentPolicy,
  type ExecutionRunPolicy,
} from '@/agent/executionRuns/policy/executionRunPolicy';
import type { ExecutionRunHostBridgeContract } from '@/agent/runtime/bridges/executionRun/executionRunBridgeContract';
import { resolveExecutionRunRuntimeBackendId } from '@/agent/runtime/bridges/executionRun/backendTargets';
import { VoiceAgentError } from '@/agent/voice/agent/VoiceAgentManager';
import { resolveCliFeatureDecision } from '@/features/featureDecisionService';
import { fetchServerFeaturesSnapshot, type CliServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import { isActionApprovalRequiredByEnv, isActionEnabledByEnv } from '@/settings/actionsSettings';

import type { RpcActionExecutor } from '../_actionDispatchAdapter';

type ExecutionRunRpcFailure = Readonly<{ ok: false; error: string; errorCode: string }>;
type ExecutionRunStartResult =
  | Readonly<{ ok: true; runId: string; callId: string; sidechainId: string }>
  | ExecutionRunRpcFailure;

type ExecutionRunRpcActionDepsParams = Readonly<{
  manager: ExecutionRunHostBridgeContract;
  context: ExecutionRunRpcActionContext;
  policy: ExecutionRunPolicy;
  isExecutionRunsEnabled: () => boolean;
}>;

type ExecutionRunRpcActionContext = Readonly<{
  sessionId: string;
  cwd: string;
  serverUrl?: string;
  budgetRegistry?: unknown;
  getServerFeaturesSnapshot?: () => CliServerFeaturesSnapshot | undefined;
  resolveAccountSettings?: () => Promise<Record<string, unknown> | null> | Record<string, unknown> | null;
}>;

function executionRunsDisabled(): ExecutionRunRpcFailure {
  return { ok: false, error: 'Execution runs feature disabled', errorCode: 'execution_run_not_allowed' };
}

function invalidParams(): ExecutionRunRpcFailure {
  return { ok: false, error: 'Invalid params', errorCode: 'execution_run_invalid_action_input' };
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

function createExecutionRunRpcActionDeps(params: ExecutionRunRpcActionDepsParams): ActionExecutorDeps {
  const ensureEnabled = (): ExecutionRunRpcFailure | null => params.isExecutionRunsEnabled()
    ? null
    : executionRunsDisabled();
  let cachedServerSnapshot: CliServerFeaturesSnapshot | undefined;

  async function startRun(raw: unknown): Promise<ExecutionRunStartResult> {
    const disabled = ensureEnabled();
    if (disabled) return disabled;
    const parsed = ExecutionRunStartRequestSchema.safeParse(raw);
    if (!parsed.success) return invalidParams();
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
        return {
          ok: false,
          error: featureId === 'voice' ? 'Voice feature disabled' : 'Feature disabled',
          errorCode: 'execution_run_not_allowed',
        };
      }
    }
    if (!params.context.budgetRegistry) {
      if (
        typeof params.policy.maxConcurrentRuns === 'number'
        && params.manager.getRunningCount() >= params.policy.maxConcurrentRuns
      ) {
        return { ok: false, error: 'Execution run budget exceeded', errorCode: 'execution_run_budget_exceeded' };
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
      return policyValidation;
    }
    const backendTarget = convertBackendTargetRefV2ToV1(parsed.data.backendTarget);
    const backendId = resolveExecutionRunRuntimeBackendId(backendTarget);
    if (intentPolicy.startPreflight) {
      const preflight = await intentPolicy.startPreflight({
        backendId,
        intentInput: parsed.data.intentInput,
        cwd: params.context.cwd,
        env: process.env,
      });
      if (!preflight.ok) {
        return preflight;
      }
    }
    if (!params.policy.allowIoModes.has(parsed.data.ioMode)) {
      return { ok: false, error: 'Unsupported ioMode', errorCode: 'execution_run_not_allowed' };
    }

    const parentRunId = readParentRef(raw, 'parentRunId');
    const parentCallId = readParentRef(raw, 'parentCallId');
    if (parentRunId || parentCallId) {
      const parentDepth = parentRunId
        ? params.manager.getDepthByRunId(parentRunId)
        : params.manager.getDepthByCallId(parentCallId);
      if (typeof parentDepth !== 'number') {
        return { ok: false, error: 'Invalid parent run reference', errorCode: 'execution_run_invalid_action_input' };
      }
      if (parentDepth + 1 > params.policy.maxDepth) {
        return { ok: false, error: 'Run depth exceeded', errorCode: 'run_depth_exceeded' };
      }
    }
    try {
      const accountSettings = await params.context.resolveAccountSettings?.() ?? null;

      const started = await params.manager.start({
        sessionId: params.context.sessionId,
        ...(accountSettings ? { accountSettings } : {}),
        ...parsed.data,
        backendTarget,
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
      const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
      if (code === 'execution_run_budget_exceeded') {
        return { ok: false, error: 'Execution run budget exceeded', errorCode: 'execution_run_budget_exceeded' };
      }
      if (error instanceof VoiceAgentError) {
        return { ok: false, error: error.message, errorCode: error.code };
      }
      return {
        ok: false,
        error: error instanceof Error ? error.message : 'Execution failed',
        errorCode: 'execution_run_failed',
      };
    }
  }

  return {
    executionRunStart: async (_sessionId, request) => {
      const disabled = ensureEnabled();
      if (disabled) return disabled;
      const started = await startRun(request);
      return started.ok
        ? { runId: started.runId, callId: started.callId, sidechainId: started.sidechainId }
        : started;
    },
    executionRunList: async (_sessionId, request) => {
      const disabled = ensureEnabled();
      if (disabled) return disabled;
      const listRequest = ExecutionRunListRequestSchema.parse(request);
      return { runs: params.manager.listPublicForRequest(listRequest) };
    },
    executionRunGet: async (_sessionId, request) => {
      const disabled = ensureEnabled();
      if (disabled) return disabled;
      const parsed = ExecutionRunGetRequestSchema.parse(request);
      const run = params.manager.getPublic(parsed.runId);
      if (!run) {
        return { ok: false, error: 'Not found', errorCode: 'execution_run_not_found' };
      }
      const structuredMeta = parsed.includeStructured ? params.manager.getStructuredMeta(parsed.runId) : null;
      const latestToolResult = params.manager.getLatestToolResult(parsed.runId);
      return {
        run,
        ...(latestToolResult ? { latestToolResult } : {}),
        ...(structuredMeta ? { structuredMeta } : {}),
      };
    },
    executionRunSend: async (_sessionId, request) => {
      const disabled = ensureEnabled();
      if (disabled) return disabled;
      const parsed = ExecutionRunSendRequestSchema.parse(request);
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
    executionRunEnsure: async (_sessionId, request) => {
      const disabled = ensureEnabled();
      if (disabled) return disabled;
      const parsed = ExecutionRunEnsureRequestSchema.parse(request);
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
    executionRunEnsureOrStart: async (_sessionId, request) => {
      const disabled = ensureEnabled();
      if (disabled) return disabled;
      const parsed = ExecutionRunEnsureOrStartRequestSchema.parse(request);
      const runId = typeof parsed.runId === 'string' ? parsed.runId.trim() : '';
      if (runId) {
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

      const started = await startRun(parsed.start);
      if (!started.ok) return started;
      return { ok: true, runId: started.runId, created: true };
    },
    executionRunStreamStart: async (_sessionId, request) => {
      const disabled = ensureEnabled();
      if (disabled) return disabled;
      const parsed = ExecutionRunTurnStreamStartRequestSchema.parse(request);
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
    executionRunStreamRead: async (_sessionId, request) => {
      const disabled = ensureEnabled();
      if (disabled) return disabled;
      const parsed = ExecutionRunTurnStreamReadRequestSchema.parse(request);
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
    executionRunStreamCancel: async (_sessionId, request) => {
      const disabled = ensureEnabled();
      if (disabled) return disabled;
      const parsed = ExecutionRunTurnStreamCancelRequestSchema.parse(request);
      const cancelled = await params.manager.cancelTurnStream(parsed.runId, { streamId: parsed.streamId });
      if (!cancelled.ok) {
        return { ok: false, error: cancelled.error, errorCode: cancelled.errorCode };
      }
      return { ok: true };
    },
    executionRunStop: async (_sessionId, request) => {
      const disabled = ensureEnabled();
      if (disabled) return disabled;
      const parsed = ExecutionRunGetRequestSchema.parse(request);
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
    executionRunAction: async (_sessionId, request) => {
      const disabled = ensureEnabled();
      if (disabled) return disabled;
      const parsed = ExecutionRunActionRequestSchema.parse(request);
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
    executionRunWait: unsupportedActionDependency,

    sessionOpen: unsupportedActionDependency,
    sessionFork: unsupportedActionDependency,
    sessionRollback: unsupportedActionDependency,
    sessionSpawnNew: unsupportedActionDependency,
    sessionSpawnPicker: unsupportedActionDependency,

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

    isActionEnabled: (id, ctx) => isActionEnabledByEnv(id, {
      surface: ctx.surface ?? null,
      placement: ctx.placement ?? null,
    }),
    isActionApprovalRequired: (id, ctx) => isActionApprovalRequiredByEnv(id, {
      surface: ctx.surface ?? null,
    }),
    // Approval artifact storage belongs to A.12-approvals; until that packet wires
    // RPC approval storage, approval-required execution-run RPC actions fail closed.
  };
}

export function createExecutionRunRpcActionExecutor(
  params: ExecutionRunRpcActionDepsParams,
): RpcActionExecutor {
  return createActionExecutor(createExecutionRunRpcActionDeps(params));
}
