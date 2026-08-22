import { randomUUID } from 'node:crypto';

import { logger } from '@/ui/logger';
import type { AgentMessage, McpServerConfig } from '@/agent';
import type { MessageBuffer } from '@/ui/ink/messageBuffer';
import { isThinkingToolName } from '@/agent/acp/bridge/thinkingToolCall';
import { importAcpReplaySidechainV1 } from '@/agent/acp/history/importAcpReplaySidechain';
import type { AcpRuntimeSessionClient } from '@/agent/acp/sessionClient';
import type { AcpPermissionHandler } from '@/agent/acp/permissions/acpPermissionHandler';
import type { AcpReplayBackend } from '../acpRuntimeBackendContract';

import type { BoundedToolCallNameCache } from '../createBoundedToolCallNameCache';
import type { AcpSendFn } from '@/agent/acp/bridge/acpSessionForwarding';

type ToolResultMessage = Extract<AgentMessage, { type: 'tool-result' }>;

type Forwarder = Readonly<{ forward: (msg: AgentMessage) => void }>;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function handleAcpRuntimeToolResultMessage(params: {
  provider: string;
  transcriptProvider: string;
  directory: string;
  session: AcpRuntimeSessionClient;
  messageBuffer: MessageBuffer;
  mcpServers: Record<string, McpServerConfig>;
  permissionHandler: AcpPermissionHandler;
  msg: ToolResultMessage;
  forwarder: Forwarder;
  toolCallNameCache: BoundedToolCallNameCache;
  hooks?: {
    onToolResult?: (params: { toolName: string; callId: string; result: unknown }) => void;
  };
  createReplayBackend?: () => Promise<AcpReplayBackend>;
  publishTranscriptAgentMessageCommitted: AcpSendFn;
}): void {
  const msg = params.msg;
  const callId = msg.callId;

  params.toolCallNameCache.evict(Date.now());
  const originToolName = params.toolCallNameCache.get(callId) ?? msg.toolName;
  if (typeof originToolName === 'string' && isThinkingToolName(originToolName)) {
    params.forwarder.forward(msg);
    return;
  }

  const resultRecord =
    msg.result && typeof msg.result === 'object' && !Array.isArray(msg.result)
      ? (msg.result as Record<string, unknown>)
      : null;
  const maybeStream =
    !!resultRecord && (typeof resultRecord.stdoutChunk === 'string' || resultRecord._stream === true);
  if (!maybeStream) {
    const outputText = typeof msg.result === 'string'
      ? msg.result
      : JSON.stringify(msg.result ?? '').slice(0, 200);
    params.messageBuffer.addMessage(`Result: ${outputText}`, 'result');
  }

  params.forwarder.forward(msg);

  if (typeof originToolName === 'string' && originToolName.length > 0) {
    try {
      params.hooks?.onToolResult?.({ toolName: originToolName, callId, result: msg.result });
    } catch (e) {
      logger.debug(`[${params.provider}] onToolResult hook failed (non-fatal)`, e);
    }
  }

  // Provider-agnostic sidechain import: if a Task tool-result includes a vendor session id,
  // capture its replay in a separate backend and import it as a sidechain thread.
  if (typeof originToolName === 'string' && originToolName.toLowerCase() === 'task') {
    const record = asRecord(msg.result);
    const metadata = record ? asRecord(record.metadata) : null;
    const metadataSessionIdRaw = metadata?.sessionId;
    const metadataSessionId = typeof metadataSessionIdRaw === 'string' ? metadataSessionIdRaw : null;
    const outputValue = record?.output;
    const outputText = typeof outputValue === 'string' ? outputValue : null;
    const contentValue = record?.content;
    const contentText = typeof contentValue === 'string' ? contentValue : null;
    const fallbackSidechainText = (() => {
      const raw = (contentText ?? outputText ?? '').trim();
      if (!raw) return '';
      // Strip embedded task metadata blocks so the sidechain preview is mostly the assistant output.
      return raw.replace(/<task_metadata>[\s\S]*?<\/task_metadata>/gi, '').trim();
    })();
    const embeddedSessionId = outputText
      ? (() => {
          const match = outputText.match(/<task_metadata>[\s\S]*?session_id:\s*([^\s<]+)[\s\S]*?<\/task_metadata>/i);
          return match?.[1] ? String(match[1]) : null;
        })()
      : null;
    const remoteSessionId = (metadataSessionId ?? embeddedSessionId)?.trim() || '';

    if (remoteSessionId && params.createReplayBackend) {
      const createReplayBackend = params.createReplayBackend;
      void (async () => {
        let replayBackend: AcpReplayBackend | null = null;
        let replayImported = false;
        try {
          replayBackend = await createReplayBackend();
          const canReplay = Boolean(replayBackend.loadSessionWithReplayCapture);
          if (canReplay) {
            const loaded = await replayBackend.loadSessionWithReplayCapture!(remoteSessionId);
            const replay = loaded.replay;
            if (Array.isArray(replay) && replay.length > 0) {
              await importAcpReplaySidechainV1({
                session: params.session,
                provider: params.transcriptProvider,
                remoteSessionId,
                sidechainId: callId,
                replay: replay as unknown[],
              });
              replayImported = true;
              return;
            }
          }
        } catch (e) {
          logger.debug(`[${params.provider}] Failed to import Task sidechain replay (non-fatal)`, e);
        } finally {
          // Fallback: if we can't replay-import, at least persist the Task output as a sidechain message.
          if (!replayImported && fallbackSidechainText) {
            try {
              params.publishTranscriptAgentMessageCommitted(
                params.transcriptProvider,
                { type: 'message', message: fallbackSidechainText, sidechainId: callId },
                { localId: randomUUID(), meta: { importedFrom: 'acp-sidechain', remoteSessionId, sidechainId: callId } },
              );
            } catch (e) {
              logger.debug(`[${params.provider}] Failed to persist Task sidechain fallback message (non-fatal)`, e);
            }
          }
          params.toolCallNameCache.delete(callId);
          if (replayBackend) {
            try {
              await replayBackend.dispose();
            } catch (e) {
              logger.debug(`[${params.provider}] Failed to dispose replay backend (non-fatal)`, e);
            }
          }
        }
      })();
    } else {
      params.toolCallNameCache.delete(callId);
    }
  } else {
    params.toolCallNameCache.delete(callId);
  }
}
