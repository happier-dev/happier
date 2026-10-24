import type { RpcHandlerContext, RpcHandlerRegistrar } from '@/api/rpc/types';
import type { ACPMessageData, ACPProvider } from '@/api/session/sessionMessageTypes';
import type { AcpSendFn } from '@/agent/acp/bridge/acpSessionForwarding';
import type { AgentBackend } from '@/agent/core/AgentBackend';
import type { AcpConfigOptionOverridesV1, BackendTargetRefV1, ExecutionRunPublicState } from '@happier-dev/protocol';

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
  ExecutionRunTurnStreamStartV2RequestSchema,
  ExecutionRunUserTranscriptCommitRequestSchema,
  ExecutionRunTurnStreamReadRequestSchema,
  ExecutionRunTurnStreamCancelRequestSchema,
} from '@happier-dev/protocol';

import { ExecutionRunManager } from '@/agent/executionRuns/runtime/ExecutionRunManager';
import type { ExecutionRunStartResult } from '@/agent/executionRuns/runtime/executionRunTypes';
import type { SessionRuntimeActivityContributionHandle } from '@/session/runtimeActivity/types';
import {
  ExecutionRunConnectedServicesUnavailableError,
  prepareExecutionRunConnectedServices,
} from '@/agent/executionRuns/runtime/prepareExecutionRunConnectedServices';
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
import { resolveReviewExecutionRunIntentInput } from '@/agent/reviews/resolveReviewExecutionRunIntentInput';
import { applyExecutionRunListRequest } from '@/session/services/applyExecutionRunListRequest';
import { preflightCodeRabbitReviewScope } from '@/agent/reviews/engines/coderabbit/preflightCodeRabbitReviewScope';
import { readCodeRabbitReviewConfigFromEnv } from '@/agent/reviews/engines/coderabbit/readCodeRabbitReviewConfig';
import { readCredentials } from '@/persistence';
import { configuration } from '@/configuration';
import { resolveReplaySeedDraft, type ReplaySeedDraftResolution } from '@/session/replay/resolveReplaySeedDraft';
import { fingerprintExecutionRunStartRequest } from '@/agent/executionRuns/executionRunStartFingerprint';

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
    resolveCwd?: () => string;
    serverUrl?: string;
    parentProvider: ACPProvider;
    createBackend: (opts: {
      runId?: string;
      backendId: string;
      backendTarget?: BackendTargetRefV1;
      permissionMode: string;
      modelId?: string;
      sessionConfigOptionOverrides?: AcpConfigOptionOverridesV1;
      accountSettings?: Readonly<Record<string, unknown>> | null;
      start?: any;
      connectedServicesEnv?: Readonly<Record<string, string>> | null;
      connectedServicesCleanup?: (() => Promise<void>) | null;
    }) => AgentBackend;
    sendAcp: AcpSendFn;
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
      appendUserTextCommitted?: (
        text: string,
        options: Readonly<{ localId: string; meta: Record<string, unknown> }>,
      ) => Promise<void>;
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
    runtimeActivityContributionHandle?: SessionRuntimeActivityContributionHandle | null;
    enqueueParentSessionInput?: (input: Readonly<{ text: string; meta: Record<string, unknown> }>) => Promise<void>;
    onExecutionRunPublicStateUpdated?: (run: ExecutionRunPublicState) => void;
    resolveAccountSettings?: () => Promise<Record<string, unknown> | null> | Record<string, unknown> | null;
  }>,
): Readonly<{ dispose: () => Promise<void> }> {
  const resolveCwd = ctx.resolveCwd ?? (() => ctx.cwd);
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
    resolveCwd,
    createBackend: ctx.createBackend,
    sendAcp: ctx.sendAcp,
    streamedTranscriptSession: ctx.streamedTranscriptSession,
    transcriptWriter: ctx.transcriptWriter,
    onPublicStateUpdated: ctx.onExecutionRunPublicStateUpdated,
    boundedTimeoutMs: policy.boundedTimeoutMs ?? undefined,
    maxTurns: policy.maxTurns ?? undefined,
    budgetRegistry: ctx.budgetRegistry,
    runtimeActivityContributionHandle: ctx.runtimeActivityContributionHandle,
    ...(ctx.enqueueParentSessionInput
      ? { enqueueParentSessionInput: ctx.enqueueParentSessionInput }
      : {}),
    resolveAccountSettings: ctx.resolveAccountSettings,
    // Resume rehydration re-materializes connected services through the SAME canonical CS owner used
    // at start, driven by the run's persisted selection. Fail-closed: a run with a persisted CS
    // selection re-materializes the account or does not resume (never falls back to ambient auth).
    prepareConnectedServices: async (params) =>
      prepareExecutionRunConnectedServices({
        backendTarget: params.backendTarget,
        connectedServices: params.connectedServices,
        credentials: await readCredentials().catch(() => null),
        cwd: resolveCwd(),
        sessionId: params.sessionId,
        ...(params.previousMaterializedRoot ? { previousMaterializedRoot: params.previousMaterializedRoot } : {}),
      }),
  });

  let cachedServerSnapshot: CliServerFeaturesSnapshot | undefined;

  function readRunResult(runId: string, includeStructured: boolean): Readonly<Record<string, unknown>> | null {
    const run = manager.getPublic(runId);
    if (!run) return null;
    const structuredMeta = includeStructured ? manager.getStructuredMeta(runId) : null;
    const latestToolResult = manager.getLatestToolResult(runId);
    return {
      run,
      ...(latestToolResult ? { latestToolResult } : {}),
      ...(structuredMeta ? { structuredMeta } : {}),
    };
  }

  function isExecutionRunsEnabled(): boolean {
    return resolveCliFeatureDecision({ featureId: 'execution.runs', env: process.env }).state === 'enabled';
  }

  async function startRun(raw: unknown): Promise<
    | ({ ok: true } & ExecutionRunStartResult)
    | { ok: false; error: string; errorCode: string }
  > {
    if (!isExecutionRunsEnabled()) return executionRunsDisabled();
    const parsed = ExecutionRunStartRequestSchema.safeParse(raw);
    if (!parsed.success) return invalidParams();
    const startRequestFingerprint = parsed.data.startRequestId
      ? fingerprintExecutionRunStartRequest(parsed.data)
      : undefined;
    try {
      const existing = manager.resolveStartRequest({
        startRequestId: parsed.data.startRequestId,
        startRequestFingerprint,
      });
      if (existing) return { ok: true, ...existing };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : 'Execution run start request conflict',
        errorCode: 'execution_run_start_conflict',
      };
    }
    const backendId = resolveExecutionRunRuntimeBackendId(parsed.data.backendTarget);
    let normalizedReviewIntentInput: unknown;
    let hasNormalizedReviewIntentInput = false;
    if (parsed.data.intent === 'review') {
      const reviewInput = resolveReviewExecutionRunIntentInput(parsed.data.intentInput, {
        engineId: backendId,
        instructions: parsed.data.instructions ?? '',
      });
      if (reviewInput.kind === 'invalid') {
        return {
          ok: false,
          error: 'Invalid review intentInput; omit it for a default prompt review or provide a valid review start or follow-up payload',
          errorCode: 'execution_run_invalid_action_input',
        };
      }
      if (reviewInput.kind === 'review_start') {
        normalizedReviewIntentInput = reviewInput.input;
        hasNormalizedReviewIntentInput = true;
      }
    }
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
    if (parsed.data.intent === 'review' && backendId === 'coderabbit') {
      const codeRabbitConfig = readCodeRabbitReviewConfigFromEnv(process.env);
      let preflight;
      try {
        preflight = await preflightCodeRabbitReviewScope({
          cwd: resolveCwd(),
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
    let preparedConnectedServicesForFailureRelease:
      Awaited<ReturnType<typeof prepareExecutionRunConnectedServices>> = null;
    try {
      const accountSettings = await ctx.resolveAccountSettings?.() ?? null;
      const startParams: any = {
        ...(parsed.data as any),
        ...(startRequestFingerprint ? { startRequestFingerprint } : {}),
        ...(hasNormalizedReviewIntentInput ? { intentInput: normalizedReviewIntentInput } : {}),
      };

      // ER-CS: resolve the run's connected-services selection (explicit per-target selection, else the
      // session spawn defaulting owner — the SAME blocking settings bootstrap sessions use, QA2-F02)
      // and materialize it via the daemon bridge. Fail-closed: a run WITH a selection either starts on
      // the materialized account or does not start at all.
      let preparedConnectedServices: Awaited<ReturnType<typeof prepareExecutionRunConnectedServices>> = null;
      try {
        preparedConnectedServices = await prepareExecutionRunConnectedServices({
          backendTarget: parsed.data.backendTarget,
          connectedServices: (parsed.data as { connectedServices?: unknown }).connectedServices,
          connectedServicesDefaultServiceIds:
            (parsed.data as { connectedServicesDefaultServiceIds?: readonly string[] }).connectedServicesDefaultServiceIds,
          // Unreadable credentials degrade to the native path (logged by prepare), matching how
          // session spawn defaulting degrades when its settings bootstrap fails.
          credentials: await (async () => {
            try {
              return (await readCredentials()) ?? null;
            } catch {
              return null;
            }
          })(),
          cwd: resolveCwd(),
          sessionId: ctx.sessionId,
        });
      } catch (error) {
        if (error instanceof ExecutionRunConnectedServicesUnavailableError) {
          return { ok: false, error: error.message, errorCode: error.code };
        }
        throw error;
      }
      preparedConnectedServicesForFailureRelease = preparedConnectedServices;
      if (preparedConnectedServices) {
        startParams.connectedServicesEnv = preparedConnectedServices.env;
        startParams.connectedServicesCleanup = preparedConnectedServices.cleanup;
        // Persist the resolved selection into the run's immutable launch record so a later resume can
        // re-materialize the SAME account/profile (fail-closed) instead of ambient auth.
        startParams.connectedServicesSelection = preparedConnectedServices.selection;
        startParams.connectedServicesRegistration = preparedConnectedServices.registration;
      }
      delete startParams.connectedServices;
      if (parsed.data.intent === 'voice_agent' && parsed.data.replay?.kind === 'voice_session.v1') {
        const credentials = await readCredentials().catch(() => null);
        if (credentials) {
          const replayStrategy =
            parsed.data.replay.strategy === 'summary_plus_recent' ? 'summary_plus_recent' : 'recent_messages';
          const replaySeed = await resolveReplaySeedDraft({
            credentials,
            cwd: resolveCwd(),
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
          }).catch((): ReplaySeedDraftResolution => ({ status: 'unavailable' }));
          // A voice run seeds when there is something to seed with; an empty
          // source and a failed retrieval both leave it unseeded here.
          if (replaySeed.status === 'seeded') {
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
      // ER-CS: the run never started; release the daemon-side registration + materialized root now
      // instead of leaking it until pid death (cleanup is idempotent + best-effort).
      await preparedConnectedServicesForFailureRelease?.cleanup().catch(() => {});
      const code = (error as any)?.code;
      if (code === 'execution_run_budget_exceeded') {
        return { ok: false, error: 'Execution run budget exceeded', errorCode: 'execution_run_budget_exceeded' };
      }
      if (code === 'execution_run_start_conflict') {
        return { ok: false, error: 'Execution run start request conflict', errorCode: 'execution_run_start_conflict' };
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
    return {
      runId: started.runId,
      callId: started.callId,
      sidechainId: started.sidechainId,
      ...(started.requestedConfiguration ? { requestedConfiguration: started.requestedConfiguration } : {}),
    };
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
    const result = readRunResult(parsed.data.runId, parsed.data.includeStructured === true);
    return result ?? { ok: false, error: 'Not found', errorCode: 'execution_run_not_found' };
  });

  rpc.registerHandler(SESSION_RPC_METHODS.EXECUTION_RUN_WAIT, async (
    raw: unknown,
    _legacyLocalOptions?: undefined,
    context?: RpcHandlerContext,
  ) => {
    if (!isExecutionRunsEnabled()) return { ok: false, code: 'execution_run_not_allowed', message: 'Execution runs feature disabled' };
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, code: 'execution_run_invalid_action_input', message: 'Invalid params' };
    const request = raw as Record<string, unknown>;
    const rawRunId = request.runId;
    const runId = typeof rawRunId === 'string'
      ? rawRunId.trim()
      : '';
    const rawTimeoutSeconds = request.timeoutSeconds;
    const timeoutMs = typeof rawTimeoutSeconds === 'number' && Number.isFinite(rawTimeoutSeconds) && rawTimeoutSeconds > 0
      ? Math.max(1, Math.floor(rawTimeoutSeconds * 1_000))
      : null;
    if (!runId) return { ok: false, code: 'execution_run_invalid_action_input', message: 'Invalid params' };

    const initial = readRunResult(runId, true);
    if (!initial) return { ok: false, code: 'execution_run_not_found', message: 'Not found' };
    const initialStatus = (initial.run as ExecutionRunPublicState).status;
    if (initialStatus !== 'running') return { ok: true, status: initialStatus, result: initial };

    context?.signal.throwIfAborted();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let removeAbortListener = () => {};
    const waitObserverAbort = new AbortController();
    const deadlineAtMs = timeoutMs === null ? null : Date.now() + timeoutMs;
    const observationTimedOut = Symbol('execution-run-observation-timeout');
    const outcomes: Array<Promise<null | typeof observationTimedOut>> = [
      manager.waitForTerminal(runId, { signal: waitObserverAbort.signal }).then(() => null),
    ];
    if (timeoutMs !== null) {
      outcomes.push(
        new Promise<typeof observationTimedOut>((resolve) => {
          timer = setTimeout(() => resolve(observationTimedOut), timeoutMs);
        }),
      );
    }
    if (context?.signal) {
      outcomes.push(new Promise<never>((_resolve, reject) => {
        const onAbort = () => reject(
          context.signal.reason ?? new Error('RPC request cancelled by caller'),
        );
        context.signal.addEventListener('abort', onAbort, { once: true });
        removeAbortListener = () => context.signal.removeEventListener('abort', onAbort);
        if (context.signal.aborted) onAbort();
      }));
    }
    let outcome: null | typeof observationTimedOut;
    try {
      outcome = await Promise.race(outcomes);
    } finally {
      waitObserverAbort.abort(new Error('Execution run wait observation ended'));
      if (timer) clearTimeout(timer);
      removeAbortListener();
    }

    const result = readRunResult(runId, true);
    if (!result) return { ok: false, code: 'execution_run_not_found', message: 'Not found' };
    const status = (result.run as ExecutionRunPublicState).status;
    if (status !== 'running') return { ok: true, status, result };
    if (outcome === observationTimedOut && timeoutMs !== null) {
      const observedAtMs = Date.now();
      return {
        ok: true,
        status: 'running',
        disposition: 'observation_timeout',
        runId,
        timeoutMs,
        observedAtMs,
        deadlineAtMs: deadlineAtMs!,
      };
    }
    return { ok: false, code: 'execution_run_failed', message: 'Execution run wait ended before terminal state' };
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

  rpc.registerHandler(SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START_V2, async (raw: unknown) => {
    if (!isExecutionRunsEnabled()) return executionRunsDisabled();
    const parsed = ExecutionRunTurnStreamStartV2RequestSchema.safeParse(raw);
    if (!parsed.success) return invalidParams();
    const started = await manager.startTurnStream(parsed.data.runId, {
      message: parsed.data.message,
      ...(typeof parsed.data.displayMessage === 'string' ? { displayMessage: parsed.data.displayMessage } : {}),
      userTranscript: parsed.data.userTranscript,
      resume: parsed.data.resume,
    });
    if (!started.ok) return { ok: false, error: started.error, errorCode: started.errorCode };
    return { streamId: started.streamId };
  });

  rpc.registerHandler(SESSION_RPC_METHODS.EXECUTION_RUN_USER_TRANSCRIPT_COMMIT_V1, async (raw: unknown) => {
    if (!isExecutionRunsEnabled()) return executionRunsDisabled();
    const parsed = ExecutionRunUserTranscriptCommitRequestSchema.safeParse(raw);
    if (!parsed.success) return invalidParams();
    const committed = await manager.commitUserTranscript(parsed.data.runId, {
      message: parsed.data.message,
      ...(typeof parsed.data.displayMessage === 'string' ? { displayMessage: parsed.data.displayMessage } : {}),
      localId: parsed.data.localId,
    });
    if (!committed.ok) return { ok: false, error: committed.error, errorCode: committed.errorCode };
    return { ok: true };
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

  return { dispose: () => manager.dispose() };
}
