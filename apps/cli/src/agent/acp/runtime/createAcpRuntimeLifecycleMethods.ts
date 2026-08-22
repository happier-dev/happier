import { randomUUID } from 'node:crypto';

import { logger } from '@/ui/logger';
import { importAcpReplayHistoryV1 } from '@/agent/acp/history/importAcpReplayHistory';
import type { AcpPermissionHandler } from '@/agent/acp/permissions/acpPermissionHandler';
import { recordToolTraceEvent } from '@/agent/tools/trace/toolTrace';
import {
  applyAcpRuntimeSessionConfigOption,
  applyAcpRuntimeSessionMode,
  applyAcpRuntimeSessionModel,
} from './sessionControls/applySessionControls';
import { createStreamedTranscriptWriter } from '@/api/session/streamedTranscriptWriter';
import type { AcpRuntimeBackend } from './acpRuntimeBackendContract';
import type { AcpRuntimeSessionClient } from '@/agent/acp/sessionClient';
import { surfacePrimarySessionRuntimeIssue } from '@/agent/runtime/session/errors/surfacePrimarySessionRuntimeIssue';
import { isAbortLikeError } from '@/agent/runtime/lifecycle/classifyAbortLikeError';
import type { AcpRuntimeEventDraft } from './createAcpRuntime';
import type { AcpRuntimeTurnOutcome } from './acpRuntimeBackendContract';
import type { AcpSendFn } from '@/agent/acp/bridge/acpSessionForwarding';

type AcpRuntimeLifecycleState = {
  backend: AcpRuntimeBackend | null;
  sessionId: string | null;
  accumulatedResponse: string;
  isResponseInProgress: boolean;
  taskStartedSent: boolean;
  turnAborted: boolean;
  loadingSession: boolean;
  turnInFlight: boolean;
  currentRuntimeTurnId: string | null;
  currentTurnId: string | null;
  turnOutcome?: AcpRuntimeTurnOutcome | null;
  hadTurnActivity?: boolean;
};

type AcpRuntimeLifecycleHooks = {
  onBeginTurn?: () => void;
  onBeforeFlushTurn?: (params: {
    sendToolCall: (params: { toolName: string; input: unknown; callId?: string }) => string;
    sendToolResult: (params: { callId: string; output: unknown }) => void;
  }) => void;
};

function normalizeReplayPromptText(value: unknown): string {
  return typeof value === 'string'
    ? value.replace(/\r\n/g, '\n').replace(/\s+/g, ' ').trim()
    : '';
}

function readReplayUserMessageText(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Readonly<Record<string, unknown>>;
  return record.type === 'message' && record.role === 'user'
    ? normalizeReplayPromptText(record.text)
    : null;
}

function filterCurrentPromptFromReplay(
  replay: readonly unknown[],
  currentPromptText: string | null | undefined,
): readonly unknown[] {
  const prompt = normalizeReplayPromptText(currentPromptText);
  if (!prompt || replay.length === 0) return replay;
  const last = replay[replay.length - 1];
  return readReplayUserMessageText(last) === prompt ? replay.slice(0, -1) : replay;
}

function ensureCurrentTurnId(state: AcpRuntimeLifecycleState): string {
  if (!state.currentTurnId) state.currentTurnId = randomUUID();
  return state.currentTurnId;
}

function resetTurnState(state: AcpRuntimeLifecycleState): void {
  state.accumulatedResponse = '';
  state.isResponseInProgress = false;
  state.taskStartedSent = false;
  state.turnAborted = false;
  state.currentTurnId = null;
  state.currentRuntimeTurnId = null;
  state.turnOutcome = null;
  state.hadTurnActivity = false;
}

function isAcpRuntimeTurnOutcome(value: unknown): value is AcpRuntimeTurnOutcome {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const kind = (value as { kind?: unknown }).kind;
  return kind === 'completed' || kind === 'aborted' || kind === 'refused' || kind === 'failed' || kind === 'timed_out';
}

function isSuccessfulCompletedOutcome(outcome: AcpRuntimeTurnOutcome | null): boolean {
  if (!outcome) return true;
  return outcome.kind === 'completed' && outcome.stopReason !== 'max_turn_requests';
}

function buildAcpRuntimeTurnOutcomeError(outcome: AcpRuntimeTurnOutcome | null, provider: string): Error {
  if (!outcome) return new Error(`${provider} turn ended without output`);
  switch (outcome.kind) {
    case 'failed':
      return outcome.error;
    case 'refused':
      return new Error(`${provider} refused the turn`);
    case 'timed_out':
      return new Error(`${provider} turn timed out after ${outcome.capMs}ms`);
    case 'completed':
      return new Error(`${provider} turn ended with stop reason ${outcome.stopReason}`);
    case 'aborted':
      return new Error(`${provider} turn was ${outcome.stopReason}`);
  }
}

function applyTerminalTurnOutcome(params: Readonly<{
  state: AcpRuntimeLifecycleState;
  outcome: AcpRuntimeTurnOutcome | void;
  onThinkingChange: (thinking: boolean) => void;
  session: AcpRuntimeSessionClient;
}>): void {
  if (!isAcpRuntimeTurnOutcome(params.outcome)) return;
  params.state.turnOutcome = params.outcome;
  if (!isSuccessfulCompletedOutcome(params.outcome)) {
    params.state.turnAborted = true;
  }
  params.onThinkingChange(false);
  params.session.keepAlive(false, 'remote');
}

function createRuntimeHandledTurnAbortError(cause: unknown, provider: string): Error {
  const error = new Error(`${provider} ACP runtime turn aborted`);
  (error as Error & { cause?: unknown }).cause = cause;
  return error;
}

function rethrowPromptError(error: unknown, state: AcpRuntimeLifecycleState, provider: string): never {
  if (state.turnAborted && !isAbortLikeError(error)) {
    throw createRuntimeHandledTurnAbortError(error, provider);
  }
  throw error;
}

/**
 * A turn failure observed after the provider unambiguously accepted the prompt is not a
 * delivery failure: the prompt is already in provider context and the caller's prompt
 * custody must settle. Record the failure as this turn's outcome so `flushTurn` surfaces
 * it exactly once, instead of re-reporting it by rejecting the send.
 */
function recordPostDeliveryTurnFailure(params: Readonly<{
  state: AcpRuntimeLifecycleState;
  error: unknown;
  provider: string;
  onThinkingChange: (thinking: boolean) => void;
  session: AcpRuntimeSessionClient;
}>): void {
  if (isAbortLikeError(params.error) || params.state.turnAborted) {
    // `cancel()` and the status:error message handler already surfaced this turn's
    // cancellation/failure. Marking the turn aborted keeps `flushTurn` from publishing
    // a `task_complete` over it without emitting a second notice for the same event.
    params.state.turnAborted = true;
    params.onThinkingChange(false);
    params.session.keepAlive(false, 'remote');
    return;
  }
  applyTerminalTurnOutcome({
    state: params.state,
    outcome: {
      kind: 'failed',
      error: params.error instanceof Error
        ? params.error
        : new Error(`${params.provider} turn failed: ${String(params.error)}`),
    },
    onThinkingChange: params.onThinkingChange,
    session: params.session,
  });
}

async function abortPendingPermissionRequests(
  handler: AcpPermissionHandler,
  reason: string,
  provider: string,
): Promise<void> {
  try {
    await handler.abortPendingRequestsAndFlush?.(reason);
  } catch (error) {
    logger.debug(`[${provider}] Failed to abort pending permission requests (non-fatal)`, error);
  }
}

export function createAcpRuntimeLifecycleMethods(params: Readonly<{
  provider: string;
  transcriptProvider: string;
  session: AcpRuntimeSessionClient;
  permissionHandler: AcpPermissionHandler;
  hooks?: AcpRuntimeLifecycleHooks;
  ensureBackend: () => Promise<AcpRuntimeBackend>;
  createReplayBackend?: () => Promise<AcpRuntimeBackend>;
  publishSessionId: () => void;
  clearToolCallCache: () => void;
  state: AcpRuntimeLifecycleState;
  inFlightSteerEnabled: boolean;
  acpTraceMarkersEnabled: boolean;
  streamedTranscriptWriter: ReturnType<typeof createStreamedTranscriptWriter>;
  onThinkingChange: (thinking: boolean) => void;
  publishRuntimeEvent?: (event: AcpRuntimeEventDraft) => void;
  publishTranscriptAgentMessageCommitted: AcpSendFn;
  drainRequiredPublications: () => Promise<void>;
}>): Readonly<{
  beginTurn: () => void;
  cancel: () => Promise<void>;
  reset: () => Promise<void>;
  openSession: (opts?: { resumeId?: string | null; importHistory?: boolean; currentPromptText?: string | null }) => Promise<string>;
  setSessionMode: (modeId: string) => Promise<void>;
  setSessionModel: (modelId: string) => Promise<void>;
  setSessionConfigOption: (configId: string, value: string | number | boolean | null) => Promise<void>;
  steerPrompt: (prompt: string) => Promise<void>;
  compactContext: (command: string) => Promise<void>;
  sendPrompt: (prompt: string) => Promise<void>;
  flushTurn: () => Promise<void>;
}> {
  return Object.freeze({
    beginTurn(): void {
      void params.streamedTranscriptWriter.flushAll({ reason: 'turn-end' }).catch((e) => {
        logger.debug(`[${params.provider}] Failed to flush assistant stream at turn boundary (non-fatal)`, e);
      });
      params.state.turnInFlight = true;
      params.state.turnAborted = false;
      resetTurnState(params.state);
      const agentTurnId = ensureCurrentTurnId(params.state);
      params.state.currentRuntimeTurnId = randomUUID();
      params.publishRuntimeEvent?.({
        kind: 'turn-start',
        turnId: params.state.currentRuntimeTurnId,
        agentTurnId,
        startedBy: 'provider',
      });
      params.onThinkingChange(true);
      params.session.keepAlive(true, 'remote');
      try {
        params.hooks?.onBeginTurn?.();
      } catch (e) {
        logger.debug(`[${params.provider}] onBeginTurn hook failed (non-fatal)`, e);
      }
    },

    async cancel(): Promise<void> {
      if (!params.state.sessionId) return;
      await params.streamedTranscriptWriter.flushAll({ reason: 'abort', interruptedReason: 'cancelled' });
      const backend = await params.ensureBackend();
      let publicationFailure: unknown = null;
      try {
        await backend.cancel(params.state.sessionId);
      } finally {
        try {
          await params.drainRequiredPublications();
        } catch (error) {
          publicationFailure = error;
        }
        await abortPendingPermissionRequests(params.permissionHandler, 'ACP runtime cancelled', params.provider);
        await surfacePrimarySessionRuntimeIssue({
          provider: params.transcriptProvider,
          agentTurnId: ensureCurrentTurnId(params.state),
          sessionTurnId: params.state.currentRuntimeTurnId,
          cause: 'cancelled',
          session: params.session,
          publishTranscriptAgentMessageCommitted: params.publishTranscriptAgentMessageCommitted,
          publishRuntimeEvent: params.publishRuntimeEvent,
        });
        params.state.turnInFlight = false;
        params.state.currentRuntimeTurnId = null;
        params.state.currentTurnId = null;
        params.onThinkingChange(false);
        params.session.keepAlive(false, 'remote');
        params.clearToolCallCache();
      }
      if (publicationFailure !== null) throw publicationFailure;
    },

    async reset(): Promise<void> {
      let publicationFailure: unknown = null;
      try {
        await params.drainRequiredPublications();
      } catch (error) {
        publicationFailure = error;
      }
      params.state.sessionId = null;
      params.state.turnInFlight = false;
      resetTurnState(params.state);
      params.state.loadingSession = false;
      params.clearToolCallCache();
      params.onThinkingChange(false);
      params.session.keepAlive(false, 'remote');
      params.publishSessionId();

      if (params.state.backend) {
        try {
          await params.state.backend.dispose();
        } catch (e) {
          logger.debug(`[${params.provider}] Failed to dispose backend (non-fatal)`, e);
        }
        params.state.backend = null;
      }
      if (publicationFailure !== null) throw publicationFailure;
    },

    async openSession(opts: { resumeId?: string | null; importHistory?: boolean; currentPromptText?: string | null } = {}): Promise<string> {
      const backend = await params.ensureBackend();

      const resumeId = typeof opts.resumeId === 'string' ? opts.resumeId.trim() : '';
      const importHistory = opts.importHistory === true;
      if (resumeId) {
        if (!backend.loadSession && !backend.loadSessionWithReplayCapture) {
          throw new Error(`${params.provider} ACP backend does not support loading sessions`);
        }

        params.state.loadingSession = true;
        let replay: unknown[] | null = null;
        try {
          if (backend.loadSessionWithReplayCapture && importHistory) {
            const loaded = await backend.loadSessionWithReplayCapture(resumeId);
            params.state.sessionId = loaded.sessionId ?? resumeId;
            replay = Array.isArray(loaded.replay) ? loaded.replay : null;
          } else if (backend.loadSession) {
            const loaded = await backend.loadSession(resumeId);
            params.state.sessionId = loaded.sessionId ?? resumeId;
          } else if (backend.loadSessionWithReplayCapture) {
            const loaded = await backend.loadSessionWithReplayCapture(resumeId);
            params.state.sessionId = loaded.sessionId ?? resumeId;
          } else {
            throw new Error(`${params.provider} ACP backend does not support loading sessions`);
          }
        } finally {
          params.state.loadingSession = false;
        }

        if (replay && importHistory) {
          try {
            await importAcpReplayHistoryV1({
              session: params.session,
              provider: params.transcriptProvider,
              remoteSessionId: resumeId,
              replay: filterCurrentPromptFromReplay(replay, opts.currentPromptText),
              permissionHandler: params.permissionHandler,
            });
          } catch (e) {
            logger.debug(`[${params.provider}] Failed to import replay history (non-fatal)`, e);
          }
        }
      } else {
        const started = await backend.startSession();
        params.state.sessionId = started.sessionId;
      }

      params.publishSessionId();
      return params.state.sessionId!;
    },

    async setSessionMode(modeId: string): Promise<void> {
      await applyAcpRuntimeSessionMode(
        {
          provider: params.provider,
          getSessionId: () => params.state.sessionId,
          ensureBackend: params.ensureBackend,
        },
        modeId,
      );
    },

    async setSessionModel(modelId: string): Promise<void> {
      await applyAcpRuntimeSessionModel(
        {
          provider: params.provider,
          getSessionId: () => params.state.sessionId,
          ensureBackend: params.ensureBackend,
        },
        modelId,
      );
    },

    async setSessionConfigOption(configId: string, value: string | number | boolean | null): Promise<void> {
      await applyAcpRuntimeSessionConfigOption(
        {
          provider: params.provider,
          getSessionId: () => params.state.sessionId,
          ensureBackend: params.ensureBackend,
        },
        configId,
        value,
      );
    },

    async steerPrompt(prompt: string): Promise<void> {
      if (!params.inFlightSteerEnabled) {
        throw new Error(`${params.provider} runtime does not support in-flight steer`);
      }
      if (!params.state.sessionId) {
        throw new Error(`${params.provider} ACP session was not started`);
      }

      if (params.acpTraceMarkersEnabled) {
        recordToolTraceEvent({
          direction: 'outbound',
          sessionId: params.state.sessionId,
          protocol: 'acp',
          provider: params.provider,
          kind: 'trace-marker',
          payload: { event: 'acp_in_flight_steer' },
        });
      }

      const backend = await params.ensureBackend();
      if (backend.sendSteerPrompt) {
        await backend.sendSteerPrompt(params.state.sessionId, prompt);
      } else {
        throw new Error(`${params.provider} ACP backend does not support in-flight steer`);
      }
      params.publishSessionId();
    },

    async sendPrompt(prompt: string): Promise<void> {
      if (!params.state.sessionId) {
        throw new Error(`${params.provider} ACP session was not started`);
      }

      const backend = await params.ensureBackend();
      // Confirmed delivery, not turn completion, settles this prompt's custody: the caller
      // retires the replay activation seed the moment this call resolves. Once the provider
      // has unambiguously accepted the prompt its content is in provider context whether the
      // turn then completes, is cancelled, fails, or the backend is disposed — so nothing
      // after this point may reject the send. Ambiguous delivery stays unconfirmed on
      // purpose: the caller must keep custody and re-deliver rather than lose the content.
      let deliveryConfirmed = false;
      try {
        const submissionResult = await backend.sendPrompt(params.state.sessionId, prompt);
        if (
          submissionResult.kind === 'rejected_before_effect'
          || submissionResult.kind === 'effect_may_have_occurred'
        ) {
          throw submissionResult.error;
        }
        deliveryConfirmed = true;
        if (backend.waitForResponseComplete) {
          applyTerminalTurnOutcome({
            state: params.state,
            outcome: await backend.waitForResponseComplete(),
            onThinkingChange: params.onThinkingChange,
            session: params.session,
          });
        }
        // Deliberately INSIDE the post-delivery guard, unlike `steerPrompt`/`cancel`/`reset`
        // where a required-publication failure still rejects. Do not "restore" that here: this
        // call is the one the prompt loop reads as provider custody, so rejecting it after
        // confirmed delivery would tell the loop the prompt never landed — the seed would stay
        // live and the whole carry-over context would be re-sent on the next message, which is
        // the defect this delivery/completion split exists to prevent. Nothing is swallowed:
        // the drain is one-shot, so recording the failure as this turn's outcome makes
        // `flushTurn` surface it exactly once through `status_error` instead of twice.
        // Known narrowing: when the turn had ALREADY aborted or failed, the branch below stays
        // quiet and this publication failure is not separately named — that turn is already
        // being reported to the user as cancelled/failed, so the signal survives and only the
        // detail is lost.
        await params.drainRequiredPublications();
      } catch (error) {
        if (!deliveryConfirmed) {
          rethrowPromptError(error, params.state, params.provider);
        }
        recordPostDeliveryTurnFailure({
          state: params.state,
          error,
          provider: params.provider,
          onThinkingChange: params.onThinkingChange,
          session: params.session,
        });
      }
      params.publishSessionId();
    },

    async compactContext(command: string): Promise<void> {
      if (!params.state.sessionId) {
        throw new Error(`${params.provider} ACP session was not started`);
      }

      const backend = await params.ensureBackend();
      try {
        if (backend.compactContext) {
          await backend.compactContext(params.state.sessionId, command);
        } else {
          throw new Error(`${params.provider} ACP backend does not support context compaction`);
        }
        if (backend.waitForResponseComplete) {
          applyTerminalTurnOutcome({
            state: params.state,
            outcome: await backend.waitForResponseComplete(),
            onThinkingChange: params.onThinkingChange,
            session: params.session,
          });
        }
        await params.drainRequiredPublications();
      } catch (error) {
        rethrowPromptError(error, params.state, params.provider);
      }
      params.publishSessionId();
    },

    async flushTurn(): Promise<void> {
      await params.streamedTranscriptWriter.flushAll(
        params.state.turnAborted
          ? { reason: 'abort', interruptedReason: 'turn-aborted' }
          : { reason: 'turn-end' },
      );
      await params.drainRequiredPublications();
      await abortPendingPermissionRequests(params.permissionHandler, 'ACP runtime turn ended', params.provider);
      params.state.turnInFlight = false;
      params.onThinkingChange(false);
      params.session.keepAlive(false, 'remote');
      const outcome = params.state.turnOutcome ?? null;
      const shouldCompleteTurn =
        !params.state.turnAborted
        && isSuccessfulCompletedOutcome(outcome)
        && (!outcome || params.state.hadTurnActivity === true);

      if (shouldCompleteTurn) {
        try {
          params.hooks?.onBeforeFlushTurn?.({
            sendToolCall: ({ toolName, input, callId }) => {
              const resolvedCallId = typeof callId === 'string' && callId.length > 0 ? callId : randomUUID();
              params.publishTranscriptAgentMessageCommitted(params.transcriptProvider, {
                type: 'tool-call',
                callId: resolvedCallId,
                name: toolName,
                input,
                id: randomUUID(),
              });
              return resolvedCallId;
            },
            sendToolResult: ({ callId, output }) => {
              params.publishTranscriptAgentMessageCommitted(params.transcriptProvider, {
                type: 'tool-result',
                callId,
                output,
                id: randomUUID(),
              });
            },
          });
        } catch (e) {
          logger.debug(`[${params.provider}] onBeforeFlushTurn hook failed (non-fatal)`, e);
        }
      }

      const agentTurnId = ensureCurrentTurnId(params.state);
      if (shouldCompleteTurn) {
        params.publishTranscriptAgentMessageCommitted(
          params.transcriptProvider,
          { type: 'task_complete', id: agentTurnId },
        );
        if (params.state.currentRuntimeTurnId) {
          params.publishRuntimeEvent?.({
            kind: 'turn-complete',
            turnId: params.state.currentRuntimeTurnId,
            agentTurnId,
          });
        }
      } else if (outcome?.kind === 'aborted') {
        await surfacePrimarySessionRuntimeIssue({
          provider: params.transcriptProvider,
          agentTurnId,
          sessionTurnId: params.state.currentRuntimeTurnId,
          session: params.session,
          cause: 'cancelled',
          publishTranscriptAgentMessageCommitted: params.publishTranscriptAgentMessageCommitted,
          publishRuntimeEvent: params.publishRuntimeEvent,
        });
      } else if (!params.state.turnAborted || outcome) {
        await surfacePrimarySessionRuntimeIssue({
          provider: params.transcriptProvider,
          agentTurnId,
          sessionTurnId: params.state.currentRuntimeTurnId,
          session: params.session,
          cause: 'status_error',
          error: buildAcpRuntimeTurnOutcomeError(outcome, params.provider),
          publishTranscriptAgentMessageCommitted: params.publishTranscriptAgentMessageCommitted,
          publishRuntimeEvent: params.publishRuntimeEvent,
        });
      }

      resetTurnState(params.state);
    },
  });
}
