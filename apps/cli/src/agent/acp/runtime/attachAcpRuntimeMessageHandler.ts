import { randomUUID } from 'node:crypto';

import { logger } from '@/ui/logger';
import type { AgentMessage, McpServerConfig } from '@/agent';
import type { AcpPermissionHandler } from '@/agent/acp/permissions/acpPermissionHandler';
import type { MessageBuffer } from '@/ui/ink/messageBuffer';
import {
  handleAcpModelOutputDelta,
  handleAcpStatusRunning,
} from '@/agent/acp/bridge/acpCommonHandlers';
import { createAcpAgentMessageForwarder } from '@/agent/acp/bridge/createAcpAgentMessageForwarder';
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

type AcpRuntimeMessageState = {
  sessionId: string | null;
  accumulatedResponse: string;
  isResponseInProgress: boolean;
  taskStartedSent: boolean;
  turnAborted: boolean;
  loadingSession: boolean;
  turnInFlight: boolean;
};

type AcpRuntimeHooks = {
  onToolResult?: (params: { toolName: string; callId: string; result: unknown }) => void;
  onPermissionRequest?: (params: { permissionId: string; toolName: string; payload: unknown; reason: string }) => void;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function surfaceStatusErrorDetail(params: Readonly<{
  detailRaw: unknown;
  provider: string;
  session: AcpRuntimeSessionClient;
}>): void {
  const detail = typeof params.detailRaw === 'string' ? params.detailRaw.trim() : '';
  if (!detail || isAbortLikeError(detail)) return;
  const message = /^error[:\\s]/i.test(detail) ? detail : `Error: ${detail}`;
  params.session.sendAgentMessage(
    params.provider as Parameters<AcpRuntimeSessionClient['sendAgentMessage']>[0],
    { type: 'message', message },
  );
}

export function attachAcpRuntimeMessageHandler(params: Readonly<{
  backend: Pick<AcpRuntimeBackend, 'onMessage'>;
  provider: string;
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
}>): void {
  const seenSessionMediaKeys = new Set<string>();
  const forwarder = createAcpAgentMessageForwarder({
    sendAcp: (provider, body) => params.session.sendAgentMessage(provider, body),
    provider: params.provider,
    makeId: () => randomUUID(),
  });

  params.backend.onMessage((msg: AgentMessage) => {
    if (params.state.loadingSession) {
      if (msg.type === 'status' && msg.status === 'error') {
        surfaceStatusErrorDetail({
          detailRaw: msg.detail,
          provider: params.provider,
          session: params.session,
        });
        params.state.turnAborted = true;
        void surfacePrimarySessionRuntimeIssue({
          provider: params.provider,
          cause: isAbortLikeError(typeof msg.detail === 'string' ? msg.detail : '') ? 'cancelled' : 'status_error',
          error: msg.detail,
          session: params.session,
        });
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
          params.streamedTranscriptWriter.appendAssistantDelta(deltaRaw);
        }
        break;
      }

      case 'status': {
        if (msg.status === 'running') {
          handleAcpStatusRunning({
            session: params.session,
            agent: params.provider,
            getTaskStartedSent: () => params.state.taskStartedSent,
            setTaskStartedSent: (value) => {
              params.state.taskStartedSent = value;
            },
            makeId: () => randomUUID(),
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

        if (msg.status === 'error') {
          if (!params.state.turnAborted) {
            surfaceStatusErrorDetail({
              detailRaw: msg.detail,
              provider: params.provider,
              session: params.session,
            });
          }
          void params.streamedTranscriptWriter.flushAll({ reason: 'abort', interruptedReason: 'status-error' }).finally(() => {
            void surfacePrimarySessionRuntimeIssue({
              provider: params.provider,
              cause: isAbortLikeError(typeof msg.detail === 'string' ? msg.detail : '') ? 'cancelled' : 'status_error',
              error: msg.detail,
              session: params.session,
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
        handleAcpRuntimeToolResultMessage({
          provider: params.provider,
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
        });
        break;
      }

      case 'fs-edit': {
        params.messageBuffer.addMessage(`File edit: ${msg.description}`, 'tool');
        forwarder.forward(msg);
        break;
      }

      case 'terminal-output': {
        const data = typeof (msg as any).data === 'string' ? String((msg as any).data) : '';
        if (data) {
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
        handleAcpRuntimeEventMessage({
          provider: params.provider,
          session: params.session,
          seenSessionMediaKeys,
          streamedTranscriptWriter: params.streamedTranscriptWriter,
          msg,
        });
        break;
      }
    }
  });
}
