import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import type { ACPMessageData, ACPProvider } from '@/api/session/sessionMessageTypes';
import type { AgentBackend } from '@/agent/core/AgentBackend';
import type { BackendTargetRefV1, ExecutionRunPublicState } from '@happier-dev/protocol';

import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import {
  ExecutionRunGetRequestSchema,
  ExecutionRunListRequestSchema,
  ExecutionRunSendRequestSchema,
  ExecutionRunStartRequestSchema,
  ExecutionRunStopRequestSchema,
  ExecutionRunEnsureRequestSchema,
  ExecutionRunEnsureOrStartRequestSchema,
  ExecutionRunActionRequestSchema,
  ExecutionRunTurnStreamStartRequestSchema,
  ExecutionRunTurnStreamReadRequestSchema,
  ExecutionRunTurnStreamCancelRequestSchema,
} from '@happier-dev/protocol';

import { ExecutionRunManager } from '@/agent/executionRuns/runtime/ExecutionRunManager';
import type { ExecutionBudgetRegistry } from '@/daemon/executionBudget/ExecutionBudgetRegistry';
import {
  isSafePermissionModeForIntent,
  resolveExecutionRunPolicy,
  resolveExecutionRunStartBoundedTimeoutMs,
} from '@/agent/executionRuns/policy/executionRunPolicy';
import { VoiceAgentError } from '@/agent/voice/agent/VoiceAgentManager';
import { resolveCliFeatureDecision } from '@/features/featureDecisionService';
import { fetchServerFeaturesSnapshot, type CliServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import { resolveExecutionRunRuntimeBackendId } from '@/agent/executionRuns/runtime/backendTargets';
import { applyExecutionRunListRequest } from '@/session/services/applyExecutionRunListRequest';
import { preflightCodeRabbitReviewScope } from '@/agent/reviews/engines/coderabbit/preflightCodeRabbitReviewScope';
import { readCodeRabbitReviewConfigFromEnv } from '@/agent/reviews/engines/coderabbit/readCodeRabbitReviewConfig';
import { readCredentials } from '@/persistence';
import { configuration } from '@/configuration';
import { resolveReplaySeedDraft } from '@/session/replay/resolveReplaySeedDraft';

function invalidParams(): { ok: false; error: string; errorCode: string } {
  return { ok: false, error: 'Invalid params', errorCode: 'execution_run_invalid_action_input' };
}

function executionRunsDisabled(): { ok: false; error: string; errorCode: string } {
  return { ok: false, error: 'Execution runs feature disabled', errorCode: 'execution_run_not_allowed' };
}

function executionRunNotAllowedError(error: unknown): { ok: false; error: string; errorCode: string } {
  return {
    ok: false,
    error: error instanceof Error ? error.message : 'Execution run not allowed',
    errorCode: 'execution_run_not_allowed',
  };
}

export function registerExecutionRunHandlers(
  rpc: RpcHandlerRegistrar,
  ctx: Readonly<{
    sessionId: string;
    cwd: string;
    serverUrl?: string;
    parentProvider: ACPProvider;
    createBackend: (opts: {
      runId?: string;
      backendId: string;
      backendTarget?: BackendTargetRefV1;
      permissionMode: string;
      modelId?: string;
      accountSettings?: Readonly<Record<string, unknown>> | null;
      start?: any;
    }) => AgentBackend;
    sendAcp: (provider: ACPProvider, body: ACPMessageData, opts?: { meta?: Record<string, unknown> }) => void;
    streamedTranscriptSession?: Readonly<{
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
    onExecutionRunPublicStateUpdated?: (run: ExecutionRunPublicState) => void;
    resolveAccountSettings?: () => Promise<Record<string, unknown> | null> | Record<string, unknown> | null;
  }>,
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

  const manager = new ExecutionRunManager({
    parentProvider: ctx.parentProvider,
    cwd: ctx.cwd,
    createBackend: ctx.createBackend,
    sendAcp: ctx.sendAcp,
    streamedTranscriptSession: ctx.streamedTranscriptSession,
    transcriptWriter: ctx.transcriptWriter,
    onPublicStateUpdated: ctx.onExecutionRunPublicStateUpdated,
    boundedTimeoutMs: policy.boundedTimeoutMs ?? undefined,
    maxTurns: policy.maxTurns ?? undefined,
    budgetRegistry: ctx.budgetRegistry,
    resolveAccountSettings: ctx.resolveAccountSettings,
  });

  let cachedServerSnapshot: CliServerFeaturesSnapshot | undefined;

  function isExecutionRunsEnabled(): boolean {
    return resolveCliFeatureDecision({ featureId: 'execution.runs', env: process.env }).state === 'enabled';
  }

  async function startRun(raw: unknown): Promise<
    | { ok: true; runId: string; callId: string; sidechainId: string }
    | { ok: false; error: string; errorCode: string }
  > {
    if (!isExecutionRunsEnabled()) return executionRunsDisabled();
    const parsed = ExecutionRunStartRequestSchema.safeParse(raw);
    if (!parsed.success) return invalidParams();
    if (parsed.data.intent === 'voice_agent') {
      const serverSnapshot = ctx.getServerFeaturesSnapshot?.() ?? cachedServerSnapshot;
      let voiceDecision = resolveCliFeatureDecision({ featureId: 'voice', env: process.env, serverSnapshot });

      if (
        voiceDecision.state === 'unknown'
        && voiceDecision.blockedBy === 'server'
        && ctx.serverUrl
      ) {
        cachedServerSnapshot = await fetchServerFeaturesSnapshot({ serverUrl: ctx.serverUrl });
        const nextSnapshot = ctx.getServerFeaturesSnapshot?.() ?? cachedServerSnapshot;
        voiceDecision = resolveCliFeatureDecision({ featureId: 'voice', env: process.env, serverSnapshot: nextSnapshot });
      }

      if (voiceDecision.state !== 'enabled') {
        return { ok: false, error: 'Voice feature disabled', errorCode: 'execution_run_not_allowed' };
      }
    }
    if (!ctx.budgetRegistry) {
      if (typeof policy.maxConcurrentRuns === 'number' && manager.getRunningCount() >= policy.maxConcurrentRuns) {
        return { ok: false, error: 'Execution run budget exceeded', errorCode: 'execution_run_budget_exceeded' };
      }
    }
    if (!isSafePermissionModeForIntent(parsed.data.intent, parsed.data.permissionMode)) {
      return { ok: false, error: 'Permission denied', errorCode: 'permission_denied' };
    }
    const backendId = resolveExecutionRunRuntimeBackendId(parsed.data.backendTarget);
    if (parsed.data.intent === 'review' && backendId === 'coderabbit') {
      const codeRabbitConfig = readCodeRabbitReviewConfigFromEnv(process.env);
      let preflight;
      try {
        preflight = await preflightCodeRabbitReviewScope({
          cwd: ctx.cwd,
          intentInput: parsed.data.intentInput,
          maxEligibleFiles: codeRabbitConfig.maxEligibleFiles,
        });
      } catch (error) {
        return executionRunNotAllowedError(error);
      }
      if (!preflight.ok) {
        return { ok: false, error: preflight.error, errorCode: 'execution_run_not_allowed' };
      }
    }
    if (!policy.allowIoModes.has(parsed.data.ioMode)) {
      return { ok: false, error: 'Unsupported ioMode', errorCode: 'execution_run_not_allowed' };
    }
    if (parsed.data.intent === 'voice_agent') {
      // Voice agent uses a dedicated streaming turn protocol; enforce it so we don't accidentally
      // treat voice_agent like a generic bounded execution run.
      if (parsed.data.ioMode !== 'streaming') {
        return { ok: false, error: 'Unsupported ioMode', errorCode: 'execution_run_not_allowed' };
      }
      if (parsed.data.runClass !== 'long_lived') {
        return { ok: false, error: 'Unsupported runClass', errorCode: 'execution_run_not_allowed' };
      }
    }

    const parentRunId = typeof (raw as any)?.parentRunId === 'string' ? String((raw as any).parentRunId).trim() : '';
    const parentCallId = typeof (raw as any)?.parentCallId === 'string' ? String((raw as any).parentCallId).trim() : '';
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
      const startParams: any = { ...(parsed.data as any) };
      if (parsed.data.intent === 'voice_agent' && parsed.data.replay?.kind === 'voice_session.v1') {
        const credentials = await readCredentials().catch(() => null);
        if (credentials) {
          const replayStrategy =
            parsed.data.replay.strategy === 'summary_plus_recent' ? 'summary_plus_recent' : 'recent_messages';
          const replaySeed = await resolveReplaySeedDraft({
            credentials,
            cwd: ctx.cwd,
            source: {
              kind: 'voice_session.v1',
              previousSessionId: parsed.data.replay.previousSessionId,
              transcriptEpoch: parsed.data.replay.transcriptEpoch,
            },
            strategy: replayStrategy,
            recentMessagesCount: parsed.data.replay.recentMessagesCount ?? 16,
            maxSeedChars:
              typeof parsed.data.replay.maxSeedChars === 'number'
                ? parsed.data.replay.maxSeedChars
                : configuration.replaySeedMaxChars,
            candidateLimit: configuration.replaySeedCandidateLimit,
            summaryRunner: parsed.data.replay.summaryRunner ?? null,
          }).catch(() => null);
          if (replaySeed?.seedDraft) {
            startParams.initialContext = [String(parsed.data.initialContext ?? '').trim(), replaySeed.seedDraft]
              .filter((value) => value.length > 0)
              .join('\n\n');
            if (
              parsed.data.bootstrapMode === 'ready_handshake'
              && typeof startParams.initialContextMode !== 'string'
            ) {
              startParams.initialContextMode = 'first_turn';
            }
          }
        }
      }
      delete startParams.replay;

      // Preserve passthrough fields for intent-specific configuration (e.g. voice_agent model IDs).
      const started = await manager.start({
        sessionId: ctx.sessionId,
        ...(accountSettings ? { accountSettings } : {}),
        ...startParams,
        ...(() => {
          const boundedTimeoutMs = resolveExecutionRunStartBoundedTimeoutMs({
            policy,
            intent: parsed.data.intent,
          });
          return typeof boundedTimeoutMs === 'number' ? { boundedTimeoutMs } : {};
        })(),
        ...(parentRunId ? { parentRunId } : {}),
        ...(parentCallId ? { parentCallId } : {}),
      } as any);
      return { ok: true, ...started };
    } catch (error) {
      const code = (error as any)?.code;
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

  rpc.registerHandler(SESSION_RPC_METHODS.EXECUTION_RUN_START, async (raw: unknown) => {
    const started = await startRun(raw);
    if (!started.ok) return started;
    return { runId: started.runId, callId: started.callId, sidechainId: started.sidechainId };
  });

  rpc.registerHandler(SESSION_RPC_METHODS.EXECUTION_RUN_LIST, async (raw: unknown) => {
    if (!isExecutionRunsEnabled()) return executionRunsDisabled();
    const parsed = ExecutionRunListRequestSchema.safeParse(raw);
    if (!parsed.success) return invalidParams();
    return { runs: applyExecutionRunListRequest(manager.listPublic(), parsed.data) };
  });

  rpc.registerHandler(SESSION_RPC_METHODS.EXECUTION_RUN_GET, async (raw: unknown) => {
    if (!isExecutionRunsEnabled()) return executionRunsDisabled();
    const parsed = ExecutionRunGetRequestSchema.safeParse(raw);
    if (!parsed.success) return invalidParams();
    const run = manager.getPublic(parsed.data.runId);
    if (!run) return { ok: false, error: 'Not found', errorCode: 'execution_run_not_found' };
    const structuredMeta = parsed.data.includeStructured ? manager.getStructuredMeta(parsed.data.runId) : null;
    const latestToolResult = manager.getLatestToolResult(parsed.data.runId);
    return {
      run,
      ...(latestToolResult ? { latestToolResult } : {}),
      ...(structuredMeta ? { structuredMeta } : {}),
    };
  });

  rpc.registerHandler(SESSION_RPC_METHODS.EXECUTION_RUN_SEND, async (raw: unknown) => {
    if (!isExecutionRunsEnabled()) return executionRunsDisabled();
    const parsed = ExecutionRunSendRequestSchema.safeParse(raw);
    if (!parsed.success) return invalidParams();
    const sent = await manager.send(parsed.data.runId, {
      message: parsed.data.message,
      resume: parsed.data.resume,
      delivery: parsed.data.delivery,
    });
    if (!sent.ok) return { ok: false, error: sent.error ?? 'Send failed', errorCode: sent.errorCode ?? 'execution_run_failed' };
    return { ok: true };
  });

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

  rpc.registerHandler(SESSION_RPC_METHODS.EXECUTION_RUN_STOP, async (raw: unknown) => {
    if (!isExecutionRunsEnabled()) return executionRunsDisabled();
    const parsed = ExecutionRunStopRequestSchema.safeParse(raw);
    if (!parsed.success) return invalidParams();
    const stopped = await manager.stop(parsed.data.runId);
    if (!stopped.ok) return { ok: false, error: stopped.error ?? 'Stop failed', errorCode: stopped.errorCode ?? 'execution_run_failed' };
    return { ok: true };
  });

  rpc.registerHandler(SESSION_RPC_METHODS.EXECUTION_RUN_ACTION, async (raw: unknown) => {
    if (!isExecutionRunsEnabled()) return executionRunsDisabled();
    const parsed = ExecutionRunActionRequestSchema.safeParse(raw);
    if (!parsed.success) return invalidParams();
    const acted = await manager.applyAction(parsed.data.runId, {
      actionId: parsed.data.actionId,
      input: parsed.data.input,
    });
    if (!acted.ok) return { ok: false, error: acted.error ?? 'Unsupported', errorCode: acted.errorCode ?? 'execution_run_action_not_supported' };
    return {
      ok: true,
      ...(typeof acted.updatedToolResult !== 'undefined' ? { updatedToolResult: acted.updatedToolResult } : {}),
      ...(typeof acted.result !== 'undefined' ? { result: acted.result } : {}),
    };
  });
}
