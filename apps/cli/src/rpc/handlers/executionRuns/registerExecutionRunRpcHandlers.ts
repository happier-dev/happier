import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import type { ACPMessageData, ACPProvider } from '@/api/session/sessionMessageTypes';
import type {
  ActionExecuteResult,
  ActionId,
  ExecutionRunPublicState,
} from '@happier-dev/protocol';

import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import {
  ExecutionRunEnsureOrStartRequestSchema,
  ExecutionRunEnsureRequestSchema,
  ExecutionRunGetRequestSchema,
  ExecutionRunStartRequestSchema,
  ExecutionRunTurnStreamCancelRequestSchema,
  ExecutionRunTurnStreamReadRequestSchema,
  ExecutionRunTurnStreamStartRequestSchema,
  convertBackendTargetRefV2ToV1,
} from '@happier-dev/protocol';

import { getExecutionRunBackendDescriptor } from '@/agent/executionRuns/registry/executionRunBackendRegistry';
import { ExecutionRunHostBridge } from '@/agent/runtime/bridges/executionRun/ExecutionRunHostBridge';
import { resolveExecutionRunRuntimeBackendId } from '@/agent/runtime/bridges/executionRun/backendTargets';
import {
  resolveExecutionRunIntentPolicy,
  resolveExecutionRunPolicy,
  resolveExecutionRunStartBoundedTimeoutMs,
  validateExecutionRunStartIntentPolicy,
} from '@/agent/executionRuns/policy/executionRunPolicy';
import type { ExecutionBudgetRegistry } from '@/daemon/executionBudget/ExecutionBudgetRegistry';
import type { ExecutionRunPermissionRequestStoreProvider } from '@/agent/runtime/bridges/executionRun/executionRunPermissionResponseTarget';
import { VoiceAgentError } from '@/agent/voice/agent/VoiceAgentManager';
import { configuration } from '@/configuration';
import { resolveCliFeatureDecision } from '@/features/featureDecisionService';
import { fetchServerFeaturesSnapshot, type CliServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import { dispatchActionFromRpc, type RpcActionExecutor } from '../_actionDispatchAdapter';
import { createExecutionRunRpcActionExecutor } from './dispatchExecutionRunRpcAction';

type ExecutionRunRpcFailure = Readonly<{ ok: false; error: string; errorCode: string }>;
type ExecutionRunStartResult =
  | Readonly<{ ok: true; runId: string; callId: string; sidechainId: string }>
  | ExecutionRunRpcFailure;

export type ExecutionRunRpcHandlerContext = Readonly<{
  sessionId: string;
  cwd: string;
  serverUrl?: string;
  parentProvider: ACPProvider;
  sendAcp: (provider: ACPProvider, body: ACPMessageData, opts?: { meta?: Record<string, unknown> }) => void;
  streamedTranscriptSession?: Readonly<{
    sendAgentMessageEphemeral?: (
      provider: ACPProvider,
      body: ACPMessageData,
      opts: { localId: string; meta?: Record<string, unknown>; createdAt: number; updatedAt: number },
    ) => void | Promise<void>;
    sendAgentMessageCommitted: (
      provider: ACPProvider,
      body: ACPMessageData,
      opts: { localId: string; meta?: Record<string, unknown> },
    ) => Promise<void>;
  }>;
  transcriptWriter?: Readonly<{
    appendUserText: (text: string, meta: Record<string, unknown>) => void | Promise<void>;
    appendAssistantText: (text: string, meta: Record<string, unknown>) => void | Promise<void>;
    appendUserTextCommitted?: (text: string, meta: Record<string, unknown>) => Promise<void>;
    appendAssistantTextCommitted?: (text: string, meta: Record<string, unknown>) => Promise<void>;
  }>;
  getServerFeaturesSnapshot?: () => CliServerFeaturesSnapshot | undefined;
  policy?: Readonly<{
    maxConcurrentRuns?: number | null;
    boundedTimeoutMs?: number | null;
    reviewBoundedTimeoutMs?: number | null;
    maxTurns?: number | null;
    maxDepth?: number;
  }>;
  budgetRegistry?: ExecutionBudgetRegistry;
  getPermissionRequestStore?: ExecutionRunPermissionRequestStoreProvider | null;
  onExecutionRunPublicStateUpdated?: (run: ExecutionRunPublicState) => void;
  onExecutionRunVoiceAgentWelcomed?: (run: ExecutionRunPublicState, welcomedEpoch: number) => void | Promise<void>;
  resolveAccountSettings?: () => Promise<Record<string, unknown> | null> | Record<string, unknown> | null;
  actionExecutor?: RpcActionExecutor;
}>;

function invalidParams(): ExecutionRunRpcFailure {
  return { ok: false, error: 'Invalid params', errorCode: 'execution_run_invalid_action_input' };
}

function executionRunsDisabled(): ExecutionRunRpcFailure {
  return { ok: false, error: 'Execution runs feature disabled', errorCode: 'execution_run_not_allowed' };
}

function unwrapActionResultForRpc(result: ActionExecuteResult): unknown {
  if (result.ok) {
    return result.result;
  }
  if (result.errorCode === 'invalid_parameters') {
    return invalidParams();
  }
  return { ok: false, error: result.error, errorCode: result.errorCode };
}

function readParentRef(raw: unknown, key: 'parentRunId' | 'parentCallId'): string {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return '';
  }
  const value = (raw as Record<string, unknown>)[key];
  return typeof value === 'string' ? value.trim() : '';
}

export function registerExecutionRunRpcHandlers(
  rpc: RpcHandlerRegistrar,
  ctx: ExecutionRunRpcHandlerContext,
): void {
  const policy = resolveExecutionRunPolicy({
    defaults: {
      // Centralized configuration is the only source of truth for execution-run defaults.
      // Keep the fallback here wired to configuration so uncapped/no-timeout defaults cannot
      // silently drift from the policy that sessionClient passes in normal production wiring.
      maxConcurrentRuns: configuration.executionRunsMaxConcurrentPerSession,
      boundedTimeoutMs: configuration.executionRunsBoundedTimeoutMs,
      reviewBoundedTimeoutMs: configuration.executionRunsReviewBoundedTimeoutMs,
      maxTurns: configuration.executionRunsMaxTurns,
      maxDepth: configuration.executionRunsMaxDepth,
    },
    override: ctx.policy,
  });

  const manager = new ExecutionRunHostBridge({
    parentProvider: ctx.parentProvider,
    cwd: ctx.cwd,
    sendAcp: ctx.sendAcp,
    streamedTranscriptSession: ctx.streamedTranscriptSession,
    transcriptWriter: ctx.transcriptWriter,
    onPublicStateUpdated: ctx.onExecutionRunPublicStateUpdated,
    onVoiceAgentWelcomed: ctx.onExecutionRunVoiceAgentWelcomed,
    boundedTimeoutMs: policy.boundedTimeoutMs ?? undefined,
    maxTurns: policy.maxTurns ?? undefined,
    budgetRegistry: ctx.budgetRegistry,
    getPermissionRequestStore: ctx.getPermissionRequestStore,
    resolveAccountSettings: ctx.resolveAccountSettings,
  });

  let cachedServerSnapshot: CliServerFeaturesSnapshot | undefined;

  function isExecutionRunsEnabled(): boolean {
    return resolveCliFeatureDecision({ featureId: 'execution.runs', env: process.env }).state === 'enabled';
  }

  async function startRun(raw: unknown): Promise<ExecutionRunStartResult> {
    if (!isExecutionRunsEnabled()) return executionRunsDisabled();
    const parsed = ExecutionRunStartRequestSchema.safeParse(raw);
    if (!parsed.success) return invalidParams();
    const intentPolicy = resolveExecutionRunIntentPolicy(parsed.data.intent);
    if (intentPolicy.requiredFeatureId) {
      const featureId = intentPolicy.requiredFeatureId;
      const serverSnapshot = ctx.getServerFeaturesSnapshot?.() ?? cachedServerSnapshot;
      let featureDecision = resolveCliFeatureDecision({ featureId, env: process.env, serverSnapshot });

      if (
        featureDecision.state === 'unknown'
        && featureDecision.blockedBy === 'server'
        && ctx.serverUrl
      ) {
        cachedServerSnapshot = await fetchServerFeaturesSnapshot({ serverUrl: ctx.serverUrl });
        const nextSnapshot = ctx.getServerFeaturesSnapshot?.() ?? cachedServerSnapshot;
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
    if (!ctx.budgetRegistry) {
      if (typeof policy.maxConcurrentRuns === 'number' && manager.getRunningCount() >= policy.maxConcurrentRuns) {
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
    const backendStartPreflight = getExecutionRunBackendDescriptor(backendId)?.startPreflight;
    if (backendStartPreflight) {
      const preflight = await backendStartPreflight({
        backendId,
        intentInput: parsed.data.intentInput,
        cwd: ctx.cwd,
        env: process.env,
      });
      if (!preflight.ok) {
        return preflight;
      }
    }
    if (intentPolicy.startPreflight) {
      const preflight = await intentPolicy.startPreflight({
        backendId,
        intentInput: parsed.data.intentInput,
        cwd: ctx.cwd,
        env: process.env,
      });
      if (!preflight.ok) {
        return preflight;
      }
    }
    if (!policy.allowIoModes.has(parsed.data.ioMode)) {
      return { ok: false, error: 'Unsupported ioMode', errorCode: 'execution_run_not_allowed' };
    }

    const parentRunId = readParentRef(raw, 'parentRunId');
    const parentCallId = readParentRef(raw, 'parentCallId');
    if (parentRunId || parentCallId) {
      const parentDepth = parentRunId
        ? manager.getDepthByRunId(parentRunId)
        : manager.getDepthByCallId(parentCallId);
      if (typeof parentDepth !== 'number') {
        return { ok: false, error: 'Invalid parent run reference', errorCode: 'execution_run_invalid_action_input' };
      }
      if (parentDepth + 1 > policy.maxDepth) {
        return { ok: false, error: 'Run depth exceeded', errorCode: 'run_depth_exceeded' };
      }
    }
    try {
      const accountSettings = await ctx.resolveAccountSettings?.() ?? null;

      // Preserve passthrough fields for intent-specific configuration (e.g. voice_agent model IDs).
      const started = await manager.start({
        sessionId: ctx.sessionId,
        ...(accountSettings ? { accountSettings } : {}),
        ...parsed.data,
        backendTarget,
        ...(() => {
          const boundedTimeoutMs = resolveExecutionRunStartBoundedTimeoutMs({
            policy,
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

  const actionExecutor = ctx.actionExecutor ?? createExecutionRunRpcActionExecutor({
    manager,
    startRun,
    isExecutionRunsEnabled,
  });

  const dispatchPublicAction = async (actionId: ActionId, raw: unknown): Promise<unknown> => unwrapActionResultForRpc(
    await dispatchActionFromRpc({
      actionId,
      input: raw,
      defaultSessionId: ctx.sessionId,
      executor: actionExecutor,
    }),
  );

  rpc.registerHandler(SESSION_RPC_METHODS.EXECUTION_RUN_START, async (raw: unknown) =>
    await dispatchPublicAction('execution.run.start', raw));

  rpc.registerHandler(SESSION_RPC_METHODS.EXECUTION_RUN_LIST, async (raw: unknown) =>
    await dispatchPublicAction('execution.run.list', raw));

  rpc.registerHandler(SESSION_RPC_METHODS.EXECUTION_RUN_GET, async (raw: unknown) =>
    await dispatchPublicAction('execution.run.get', raw));

  rpc.registerHandler(SESSION_RPC_METHODS.EXECUTION_RUN_SEND, async (raw: unknown) =>
    await dispatchPublicAction('execution.run.send', raw));

  rpc.registerHandler(SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE, async (raw: unknown) => {
    if (!isExecutionRunsEnabled()) return executionRunsDisabled();
    const parsed = ExecutionRunEnsureRequestSchema.safeParse(raw);
    if (!parsed.success) return invalidParams();
    const ensured = await manager.ensure(parsed.data.runId, { resume: parsed.data.resume });
    if (!ensured.ok) return { ok: false, error: ensured.error ?? 'Ensure failed', ...(ensured.errorCode ? { errorCode: ensured.errorCode } : {}) };
    return { ok: true };
  });

  rpc.registerHandler(SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START, async (raw: unknown) => {
    if (!isExecutionRunsEnabled()) return executionRunsDisabled();
    const parsed = ExecutionRunEnsureOrStartRequestSchema.safeParse(raw);
    if (!parsed.success) return invalidParams();
    const runId = typeof parsed.data.runId === 'string' ? parsed.data.runId.trim() : '';
    if (runId) {
      const ensured = await manager.ensure(runId, { resume: parsed.data.resume });
      if (!ensured.ok) return { ok: false, error: ensured.error ?? 'Ensure failed', ...(ensured.errorCode ? { errorCode: ensured.errorCode } : {}) };
      return { ok: true, runId, created: false };
    }

    const started = await startRun(parsed.data.start);
    if (!started.ok) return started;
    return { ok: true, runId: started.runId, created: true };
  });

  rpc.registerHandler(SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START, async (raw: unknown) => {
    if (!isExecutionRunsEnabled()) return executionRunsDisabled();
    const parsed = ExecutionRunTurnStreamStartRequestSchema.safeParse(raw);
    if (!parsed.success) return invalidParams();
    const started = await manager.startTurnStream(parsed.data.runId, {
      message: parsed.data.message,
      ...(typeof parsed.data.displayMessage === 'string' ? { displayMessage: parsed.data.displayMessage } : {}),
      resume: parsed.data.resume,
    });
    if (!started.ok) return { ok: false, error: started.error, errorCode: started.errorCode };
    return { streamId: started.streamId };
  });

  rpc.registerHandler(SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_READ, async (raw: unknown) => {
    if (!isExecutionRunsEnabled()) return executionRunsDisabled();
    const parsed = ExecutionRunTurnStreamReadRequestSchema.safeParse(raw);
    if (!parsed.success) return invalidParams();
    const read = await manager.readTurnStream(parsed.data.runId, {
      streamId: parsed.data.streamId,
      cursor: parsed.data.cursor,
      maxEvents: parsed.data.maxEvents,
    });
    if (!read.ok) return { ok: false, error: read.error, errorCode: read.errorCode };
    return { streamId: read.streamId, events: read.events, nextCursor: read.nextCursor, done: read.done };
  });

  rpc.registerHandler(SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_CANCEL, async (raw: unknown) => {
    if (!isExecutionRunsEnabled()) return executionRunsDisabled();
    const parsed = ExecutionRunTurnStreamCancelRequestSchema.safeParse(raw);
    if (!parsed.success) return invalidParams();
    const cancelled = await manager.cancelTurnStream(parsed.data.runId, { streamId: parsed.data.streamId });
    if (!cancelled.ok) return { ok: false, error: cancelled.error, errorCode: cancelled.errorCode };
    return { ok: true };
  });

  rpc.registerHandler(SESSION_RPC_METHODS.EXECUTION_RUN_STOP, async (raw: unknown) =>
    await dispatchPublicAction('execution.run.stop', raw));

  rpc.registerHandler(SESSION_RPC_METHODS.EXECUTION_RUN_ACTION, async (raw: unknown) =>
    await dispatchPublicAction('execution.run.action', raw));
}
