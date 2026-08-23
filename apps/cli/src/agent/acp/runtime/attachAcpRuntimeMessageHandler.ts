import { randomUUID } from 'node:crypto';

import { logger } from '@/ui/logger';
import { sanitizeConnectedServiceDiagnosticError } from '@/daemon/connectedServices/runtimeAuth/sanitizeConnectedServiceDiagnosticString';
import type { AgentMessage, McpServerConfig } from '@/agent';
import type { AcpPermissionHandler } from '@/agent/acp/permissions/acpPermissionHandler';
import type { MessageBuffer } from '@/ui/ink/messageBuffer';
import {
  handleAcpModelOutputDelta,
  handleAcpStatusRunning,
} from '@/agent/acp/bridge/acpCommonHandlers';
import { createAcpAgentMessageForwarder } from '@/agent/acp/bridge/createAcpAgentMessageForwarder';
import type { AcpSendFn } from '@/agent/acp/bridge/acpSessionForwarding';
import { isThinkingToolName } from '@/agent/acp/bridge/thinkingToolCall';
import { recordToolTraceEvent } from '@/agent/tools/trace/toolTrace';
import { createBoundedToolCallNameCache } from './createBoundedToolCallNameCache';
import { handleAcpRuntimeEventMessage } from './publication/handleAcpRuntimeEventMessage';
import { handleAcpRuntimeToolResultMessage } from './toolCalls/handleAcpRuntimeToolResultMessage';
import { createStreamedTranscriptWriter } from '@/api/session/streamedTranscriptWriter';
import type { AcpRuntimeSessionClient } from '@/agent/acp/sessionClient';
import type { AcpRuntimeBackend } from './acpRuntimeBackendContract';
import { isAbortLikeError } from '@/agent/runtime/lifecycle/classifyAbortLikeError';
import { surfacePrimarySessionRuntimeIssue } from '@/agent/runtime/session/errors/surfacePrimarySessionRuntimeIssue';
import type { AcpRuntimeEventDraft } from './createAcpRuntime';

type AcpRuntimeMessageState = {
  sessionId: string | null;
  accumulatedResponse: string;
  isResponseInProgress: boolean;
  taskStartedSent: boolean;
  turnAborted: boolean;
  loadingSession: boolean;
  turnInFlight: boolean;
  currentRuntimeTurnId: string | null;
  currentTurnId: string | null;
  hadTurnActivity?: boolean;
};

type AcpRuntimeHooks = {
  onToolResult?: (params: { toolName: string; callId: string; result: unknown }) => void;
  onPermissionRequest?: (params: { permissionId: string; toolName: string; payload: unknown; reason: string }) => void;
  classifyRuntimeAuthFailure?: (params: {
    provider: string;
    happierSessionId: string | null;
    activeSessionId: string | null;
    error: unknown;
  }) => unknown | null | Promise<unknown | null>;
  onRuntimeAuthFailure?: (params: {
    provider: string;
    happierSessionId: string | null;
    activeSessionId: string | null;
    classification: unknown;
  }) => unknown | Promise<unknown>;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function ensureCurrentTurnId(state: AcpRuntimeMessageState): string {
  if (!state.currentTurnId) state.currentTurnId = randomUUID();
  return state.currentTurnId;
}

function abortPendingPermissionRequests(params: Readonly<{
  permissionHandler: AcpPermissionHandler;
  reason: string;
  provider: string;
}>): void {
  try {
    void params.permissionHandler.abortPendingRequestsAndFlush?.(params.reason).catch((error) => {
      logger.debug(`[${params.provider}] Failed to abort pending permission requests (non-fatal)`, error);
    });
  } catch (error) {
    logger.debug(`[${params.provider}] Failed to abort pending permission requests (non-fatal)`, error);
  }
}

async function readRuntimeAuthStatusError(params: Readonly<{
  hooks: AcpRuntimeHooks | undefined;
  provider: string;
  happierSessionId: string | null;
  activeSessionId: string | null;
  detail: unknown;
}>): Promise<unknown> {
  const classification = await params.hooks?.classifyRuntimeAuthFailure?.({
    provider: params.provider,
    happierSessionId: params.happierSessionId,
    activeSessionId: params.activeSessionId,
    error: params.detail,
  });
  if (!classification) return params.detail;
  // The provider status already terminalized this exact turn. Connected Services recovery is a
  // separate account operation and must not delay the canonical turn-failure publication that
  // Pending/continuation consume.
  void (async () => {
    try {
      await params.hooks?.onRuntimeAuthFailure?.({
        provider: params.provider,
        happierSessionId: params.happierSessionId,
        activeSessionId: params.activeSessionId,
        classification,
      });
    } catch (error) {
      logger.debug(`[${params.provider}] Runtime auth failure hook failed (non-fatal): ${sanitizeConnectedServiceDiagnosticError(error)}`);
    }
  })();
  return {
    originalError: params.detail,
    runtimeAuthClassification: classification,
  };
}

export function attachAcpRuntimeMessageHandler(params: Readonly<{
  backend: Pick<AcpRuntimeBackend, 'onMessage'>;
  provider: string;
  transcriptProvider: string;
  happierSessionId: string | null;
  directory: string;
  session: AcpRuntimeSessionClient;
  messageBuffer: MessageBuffer;
  mcpServers: Record<string, McpServerConfig>;
  permissionHandler: AcpPermissionHandler;
  hooks?: AcpRuntimeHooks;
  createReplayBackend?: () => Promise<AcpRuntimeBackend>;
  onThinkingChange: (thinking: boolean) => void;
  toolCallNameCache: ReturnType<typeof createBoundedToolCallNameCache>;
  streamedTranscriptWriter: ReturnType<typeof createStreamedTranscriptWriter>;
  acpTraceMarkersEnabled: boolean;
  clearToolCallCache: () => void;
  recordToolCall: (callId: string, toolName: string) => void;
  state: AcpRuntimeMessageState;
  publishRuntimeEvent?: (event: AcpRuntimeEventDraft) => void;
  publishTranscriptAgentMessageCommitted: AcpSendFn;
}>): Readonly<{ drainRequiredPublications: () => Promise<void> }> {
  const seenSessionMediaKeys = new Set<string>();
  let requiredPublicationTail: Promise<void> = Promise.resolve();
  let requiredPublicationFailure: unknown = null;
  const enqueueRequiredPublication = (publish: () => Promise<void>): void => {
    const publication = requiredPublicationTail.then(publish);
    requiredPublicationTail = publication.catch((error) => {
      requiredPublicationFailure ??= error;
    });
  };
  const forwarder = createAcpAgentMessageForwarder({
    sendAcp: params.publishTranscriptAgentMessageCommitted,
    provider: params.transcriptProvider,
    makeId: () => randomUUID(),
  });

  params.backend.onMessage((msg: AgentMessage) => {
    if (params.state.loadingSession) {
      if (msg.type === 'status' && msg.status === 'error') {
        params.state.turnAborted = true;
        abortPendingPermissionRequests({
          permissionHandler: params.permissionHandler,
          reason: 'ACP runtime status:error',
          provider: params.provider,
        });
        void (async () => {
          const error = await readRuntimeAuthStatusError({
            hooks: params.hooks,
            provider: params.provider,
            happierSessionId: params.happierSessionId,
            activeSessionId: params.state.sessionId,
            detail: msg.detail,
          });
          await surfacePrimarySessionRuntimeIssue({
            provider: params.transcriptProvider,
            agentTurnId: params.state.currentTurnId,
            sessionTurnId: params.state.currentRuntimeTurnId,
            cause: isAbortLikeError(typeof msg.detail === 'string' ? msg.detail : '') ? 'cancelled' : 'status_error',
            error,
            session: params.session,
            publishTranscriptAgentMessageCommitted: params.publishTranscriptAgentMessageCommitted,
            publishRuntimeEvent: params.publishRuntimeEvent,
          });
        })();
      }
      return;
    }

    switch (msg.type) {
      case 'model-output': {
        const fullText = typeof (msg as any).fullText === 'string' ? String((msg as any).fullText) : '';
        let deltaRaw = typeof (msg as any).textDelta === 'string' ? String((msg as any).textDelta) : '';
        if (!deltaRaw && fullText) {
          if (fullText.startsWith(params.state.accumulatedResponse)) {
            deltaRaw = fullText.slice(params.state.accumulatedResponse.length);
          } else {
            params.state.accumulatedResponse = '';
            deltaRaw = fullText;
          }
        }
        if (params.acpTraceMarkersEnabled && params.state.sessionId && deltaRaw.includes('ACP_STUB_')) {
          recordToolTraceEvent({
            direction: 'inbound',
            sessionId: params.state.sessionId,
            protocol: 'acp',
            provider: params.provider,
            kind: 'trace-marker',
            payload: { text: deltaRaw },
          });
        }
        handleAcpModelOutputDelta({
          delta: deltaRaw,
          messageBuffer: params.messageBuffer,
          getIsResponseInProgress: () => params.state.isResponseInProgress,
          setIsResponseInProgress: (value) => {
            params.state.isResponseInProgress = value;
          },
          appendToAccumulatedResponse: (delta) => {
            params.state.accumulatedResponse += delta;
          },
        });

        if (deltaRaw) {
          params.state.hadTurnActivity = true;
          params.streamedTranscriptWriter.appendAssistantDelta(deltaRaw);
        }
        break;
      }

      case 'status': {
        if (msg.status === 'running') {
          if (params.state.turnInFlight) {
            handleAcpStatusRunning({
              getTaskStartedSent: () => params.state.taskStartedSent,
              setTaskStartedSent: (value) => {
                params.state.taskStartedSent = value;
              },
              makeId: () => ensureCurrentTurnId(params.state),
              publishTaskStarted: (payload) => {
                params.publishTranscriptAgentMessageCommitted(params.transcriptProvider, payload);
              },
            });

            if (params.acpTraceMarkersEnabled && params.state.sessionId) {
              recordToolTraceEvent({
                direction: 'inbound',
                sessionId: params.state.sessionId,
                protocol: 'acp',
                provider: params.provider,
                kind: 'trace-marker',
                payload: { event: 'acp_status_running' },
              });
            }
          }
        }

        if (msg.status === 'error') {
          void params.streamedTranscriptWriter.flushAll({ reason: 'abort', interruptedReason: 'status-error' }).finally(async () => {
            abortPendingPermissionRequests({
              permissionHandler: params.permissionHandler,
              reason: 'ACP runtime status:error',
              provider: params.provider,
            });
            const error = await readRuntimeAuthStatusError({
              hooks: params.hooks,
              provider: params.provider,
              happierSessionId: params.happierSessionId,
              activeSessionId: params.state.sessionId,
              detail: msg.detail,
            });
            await surfacePrimarySessionRuntimeIssue({
              provider: params.transcriptProvider,
              agentTurnId: params.state.currentTurnId,
              sessionTurnId: params.state.currentRuntimeTurnId,
              cause: isAbortLikeError(typeof msg.detail === 'string' ? msg.detail : '') ? 'cancelled' : 'status_error',
              error,
              session: params.session,
              publishTranscriptAgentMessageCommitted: params.publishTranscriptAgentMessageCommitted,
              publishRuntimeEvent: params.publishRuntimeEvent,
            });
          });
          params.state.turnAborted = true;
          params.clearToolCallCache();
          params.onThinkingChange(false);
          params.session.keepAlive(false, 'remote');
        }
        if (msg.status === 'idle' && !params.state.turnInFlight) {
          params.onThinkingChange(false);
          params.session.keepAlive(false, 'remote');
        }
        break;
      }

      case 'tool-call': {
        params.state.hadTurnActivity = true;
        if (isThinkingToolName(msg.toolName)) {
          forwarder.forward(msg);
          break;
        }

        void params.streamedTranscriptWriter.flushAll({ reason: 'tool-call-boundary' });
        params.messageBuffer.addMessage(`Executing: ${msg.toolName}`, 'tool');
        params.recordToolCall(msg.callId, msg.toolName);
        forwarder.forward(msg);
        break;
      }

      case 'tool-result': {
        params.state.hadTurnActivity = true;
        handleAcpRuntimeToolResultMessage({
          provider: params.provider,
          transcriptProvider: params.transcriptProvider,
          directory: params.directory,
          session: params.session,
          messageBuffer: params.messageBuffer,
          mcpServers: params.mcpServers,
          permissionHandler: params.permissionHandler,
          msg,
          forwarder,
          toolCallNameCache: params.toolCallNameCache,
          hooks: params.hooks,
          createReplayBackend: params.createReplayBackend,
          publishTranscriptAgentMessageCommitted: params.publishTranscriptAgentMessageCommitted,
        });
        break;
      }

      case 'fs-edit': {
        params.state.hadTurnActivity = true;
        params.messageBuffer.addMessage(`File edit: ${msg.description}`, 'tool');
        forwarder.forward(msg);
        break;
      }

      case 'terminal-output': {
        const data = typeof (msg as any).data === 'string' ? String((msg as any).data) : '';
        if (data) {
          params.state.hadTurnActivity = true;
          params.messageBuffer.addMessage(data, 'result');
        }
        forwarder.forward(msg);
        break;
      }

      case 'token-count': {
        forwarder.forward(msg);
        break;
      }

      case 'permission-request': {
        params.state.hadTurnActivity = true;
        const payloadRecord = asRecord((msg as any).payload);
        const toolNameRaw = typeof payloadRecord?.toolName === 'string'
          ? payloadRecord.toolName
          : typeof (msg as any).reason === 'string'
            ? (msg as any).reason
            : '';
        const toolName = typeof toolNameRaw === 'string' && toolNameRaw.trim() ? toolNameRaw.trim() : 'unknown_tool';
        const permissionId = typeof (msg as any).id === 'string' && (msg as any).id.trim()
          ? String((msg as any).id).trim()
          : randomUUID();
        const reason = typeof (msg as any).reason === 'string' ? String((msg as any).reason) : toolName;
        try {
          params.hooks?.onPermissionRequest?.({ permissionId, toolName, payload: (msg as any).payload, reason });
        } catch (e) {
          logger.debug(`[${params.provider}] Failed to run permission-request hook (non-fatal)`, e);
        }
        void params.streamedTranscriptWriter.flushAll({ reason: 'tool-call-boundary' }).finally(() => {
          forwarder.forward(msg);
        });
        break;
      }

      case 'event': {
        if (msg.name === 'thinking' || msg.name === 'context_compaction' || msg.name === 'session_media') {
          params.state.hadTurnActivity = true;
        }
        const handleEvent = () => handleAcpRuntimeEventMessage({
          provider: params.transcriptProvider,
          session: params.session,
          seenSessionMediaKeys,
          streamedTranscriptWriter: params.streamedTranscriptWriter,
          publishRuntimeEvent: params.publishRuntimeEvent,
          publishTranscriptAgentMessageCommitted: params.publishTranscriptAgentMessageCommitted,
          msg,
        });
        if (msg.name === 'session_media') {
          enqueueRequiredPublication(handleEvent);
        } else {
          void handleEvent().catch((error) => {
            logger.debug(`[${params.provider}] ACP runtime event handling failed`, error);
          });
        }
        break;
      }
    }
  });

  return Object.freeze({
    async drainRequiredPublications(): Promise<void> {
      while (true) {
        const current = requiredPublicationTail;
        await current;
        if (current === requiredPublicationTail) break;
      }
      if (requiredPublicationFailure !== null) {
        const failure = requiredPublicationFailure;
        requiredPublicationFailure = null;
        throw failure;
      }
    },
  });
}
