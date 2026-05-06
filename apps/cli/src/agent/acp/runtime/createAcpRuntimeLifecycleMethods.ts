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
import { createAcpPendingQueuePump } from './createAcpPendingQueuePump';
import { createStreamedTranscriptWriter } from '@/api/session/streamedTranscriptWriter';
import type { AcpRuntimeBackend } from './acpRuntimeBackendContract';
import type { AcpRuntimeSessionClient } from '@/agent/acp/sessionClient';
import {
  recordPrimaryTurnCompleted,
  recordPrimaryTurnInProgress,
  surfacePrimarySessionRuntimeIssue,
} from '@/agent/runtime/session/errors/surfacePrimarySessionRuntimeIssue';

type AcpRuntimeLifecycleState = {
  backend: AcpRuntimeBackend | null;
  sessionId: string | null;
  accumulatedResponse: string;
  isResponseInProgress: boolean;
  taskStartedSent: boolean;
  turnAborted: boolean;
  loadingSession: boolean;
  turnInFlight: boolean;
};

type AcpRuntimeLifecycleHooks = {
  onBeginTurn?: () => void;
  onBeforeFlushTurn?: (params: {
    sendToolCall: (params: { toolName: string; input: unknown; callId?: string }) => string;
    sendToolResult: (params: { callId: string; output: unknown }) => void;
  }) => void;
};

function resetTurnState(state: AcpRuntimeLifecycleState): void {
  state.accumulatedResponse = '';
  state.isResponseInProgress = false;
  state.taskStartedSent = false;
  state.turnAborted = false;
}

export function createAcpRuntimeLifecycleMethods(params: Readonly<{
  provider: string;
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
  pendingQueuePump: ReturnType<typeof createAcpPendingQueuePump>;
  streamedTranscriptWriter: ReturnType<typeof createStreamedTranscriptWriter>;
  onThinkingChange: (thinking: boolean) => void;
}>): Readonly<{
  beginTurn: () => void;
  cancel: () => Promise<void>;
  reset: () => Promise<void>;
  startOrLoad: (opts?: { resumeId?: string | null; importHistory?: boolean }) => Promise<string>;
  setSessionMode: (modeId: string) => Promise<void>;
  setSessionModel: (modelId: string) => Promise<void>;
  setSessionConfigOption: (configId: string, value: string | number | boolean | null) => Promise<void>;
  steerPrompt: (prompt: string) => Promise<void>;
  sendPrompt: (prompt: string) => Promise<void>;
  flushTurn: () => Promise<void>;
}> {
  return Object.freeze({
    beginTurn(): void {
      params.state.turnInFlight = true;
      params.state.turnAborted = false;
      resetTurnState(params.state);
      params.pendingQueuePump.start();
      params.onThinkingChange(true);
      void recordPrimaryTurnInProgress({ session: params.session }).catch((e) => {
        logger.debug(`[${params.provider}] Failed to record primary turn in-progress (non-fatal)`, e);
      });
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
      try {
        await backend.cancel(params.state.sessionId);
      } finally {
        await surfacePrimarySessionRuntimeIssue({
          provider: params.provider,
          cause: 'cancelled',
          session: params.session,
        });
        params.state.turnInFlight = false;
        params.onThinkingChange(false);
        params.session.keepAlive(false, 'remote');
        params.pendingQueuePump.stop();
        params.clearToolCallCache();
      }
    },

    async reset(): Promise<void> {
      params.state.sessionId = null;
      params.state.turnInFlight = false;
      resetTurnState(params.state);
      params.state.loadingSession = false;
      params.clearToolCallCache();
      params.pendingQueuePump.stop();
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
    },

    async startOrLoad(opts: { resumeId?: string | null; importHistory?: boolean } = {}): Promise<string> {
      const backend = await params.ensureBackend();

      const resumeId = typeof opts.resumeId === 'string' ? opts.resumeId.trim() : '';
      const importHistory = opts.importHistory !== false;
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
          importAcpReplayHistoryV1({
            session: params.session,
            provider: params.provider,
            remoteSessionId: resumeId,
            replay: replay as unknown[],
            permissionHandler: params.permissionHandler,
          }).catch((e) => {
            logger.debug(`[${params.provider}] Failed to import replay history (non-fatal)`, e);
          });
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
      await backend.sendPrompt(params.state.sessionId, prompt);
      if (backend.waitForResponseComplete) {
        await backend.waitForResponseComplete(120_000);
      }
      params.publishSessionId();
    },

    async flushTurn(): Promise<void> {
      await params.streamedTranscriptWriter.flushAll(
        params.state.turnAborted
          ? { reason: 'abort', interruptedReason: 'turn-aborted' }
          : { reason: 'turn-end' },
      );
      params.state.turnInFlight = false;
      params.pendingQueuePump.stop();
      params.onThinkingChange(false);
      params.session.keepAlive(false, 'remote');
      if (!params.state.turnAborted) {
        try {
          params.hooks?.onBeforeFlushTurn?.({
            sendToolCall: ({ toolName, input, callId }) => {
              const resolvedCallId = typeof callId === 'string' && callId.length > 0 ? callId : randomUUID();
              params.session.sendAgentMessage(params.provider, {
                type: 'tool-call',
                callId: resolvedCallId,
                name: toolName,
                input,
                id: randomUUID(),
              });
              return resolvedCallId;
            },
            sendToolResult: ({ callId, output }) => {
              params.session.sendAgentMessage(params.provider, {
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

      if (!params.state.turnAborted) {
        params.session.sendAgentMessage(params.provider, { type: 'task_complete', id: randomUUID() });
        void recordPrimaryTurnCompleted({ session: params.session }).catch((e) => {
          logger.debug(`[${params.provider}] Failed to record primary turn completion (non-fatal)`, e);
        });
      }

      resetTurnState(params.state);
    },
  });
}
