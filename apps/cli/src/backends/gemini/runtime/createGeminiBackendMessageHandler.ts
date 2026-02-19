import { randomUUID } from 'node:crypto';

import type { AgentMessage } from '@/agent';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import {
  handleAcpModelOutputDelta,
  handleAcpStatusRunning,
} from '@/agent/acp/bridge/acpCommonHandlers';
import { createAcpAgentMessageForwarder } from '@/agent/acp/bridge/createAcpAgentMessageForwarder';
import { logger } from '@/ui/logger';
import { MessageBuffer } from '@/ui/ink/messageBuffer';

import { normalizeAvailableCommands, publishSlashCommandsToMetadata } from '@/agent/acp/commands/publishSlashCommands';
import { GeminiDiffProcessor } from '../utils/diffProcessor';
import { GeminiTurnMessageState } from './geminiTurnMessageState';

export function createGeminiBackendMessageHandler(params: {
  session: ApiSessionClient;
  messageBuffer: MessageBuffer;
  state: GeminiTurnMessageState;
  diffProcessor: GeminiDiffProcessor;
}): (msg: AgentMessage) => void {
  const forwarder = createAcpAgentMessageForwarder({
    sendAcp: (provider, body) => params.session.sendAgentMessage(provider, body),
    provider: 'gemini' as any,
    makeId: () => randomUUID(),
  });

  return (msg: AgentMessage): void => {
    switch (msg.type) {
      case 'model-output':
        if (msg.textDelta) {
          const delta = msg.textDelta;
          const wasInProgress = params.state.isResponseInProgress;
          handleAcpModelOutputDelta({
            delta,
            messageBuffer: params.messageBuffer,
            getIsResponseInProgress: () => params.state.isResponseInProgress,
            setIsResponseInProgress: (value) => { params.state.isResponseInProgress = value; },
            appendToAccumulatedResponse: (value) => { params.state.accumulatedResponse += value; },
          });
          if (!wasInProgress) {
            logger.debug(`[gemini] Started new response, first chunk length: ${delta.length}`);
          } else {
            logger.debug(`[gemini] Updated response, chunk length: ${delta.length}, total accumulated: ${params.state.accumulatedResponse.length}`);
          }
        }
        break;

      case 'status': {
        const statusDetail = msg.detail
          ? (typeof msg.detail === 'object' ? JSON.stringify(msg.detail) : String(msg.detail))
          : '';
        logger.debug(`[gemini] Status changed: ${msg.status}${statusDetail ? ` - ${statusDetail}` : ''}`);

        if (msg.status === 'error') {
          logger.debug(`[gemini] ⚠️ Error status received: ${statusDetail || 'Unknown error'}`);
          params.session.sendAgentMessage('gemini', {
            type: 'turn_aborted',
            id: randomUUID(),
          });
        }

        if (msg.status === 'running') {
          handleAcpStatusRunning({
            session: params.session,
            agent: 'gemini',
            messageBuffer: params.messageBuffer,
            onThinkingChange: (value) => { params.state.thinking = value; },
            getTaskStartedSent: () => params.state.taskStartedSent,
            setTaskStartedSent: (value) => { params.state.taskStartedSent = value; },
            makeId: () => randomUUID(),
          });
        } else if (msg.status === 'error') {
          params.state.thinking = false;
          params.session.keepAlive(params.state.thinking, 'remote');
          params.state.accumulatedResponse = '';
          params.state.isResponseInProgress = false;

          let errorMessage = 'Unknown error';
          if (msg.detail) {
            if (typeof msg.detail === 'object') {
              const detailObj = msg.detail as Record<string, unknown>;
              errorMessage =
                (detailObj.message as string) ||
                (detailObj.details as string) ||
                JSON.stringify(detailObj);
            } else {
              errorMessage = String(msg.detail);
            }
          }

          if (errorMessage.includes('Authentication required')) {
            errorMessage =
              `Authentication required.\n` +
              `For Google Workspace accounts, run: happier gemini project set <project-id>\n` +
              `Or use a different Google account: happier connect gemini\n` +
              `Guide: https://goo.gle/gemini-cli-auth-docs#workspace-gca`;
          }

          params.messageBuffer.addMessage(`Error: ${errorMessage}`, 'status');
          params.session.sendAgentMessage('gemini', {
            type: 'message',
            message: `Error: ${errorMessage}`,
          });
        }
        break;
      }

      case 'tool-call': {
        params.state.hadToolCallInTurn = true;
        const toolArgs = msg.args ? JSON.stringify(msg.args).substring(0, 100) : '';
        const isInvestigationTool =
          msg.toolName === 'codebase_investigator' ||
          (typeof msg.toolName === 'string' && msg.toolName.includes('investigator'));

        logger.debug(`[gemini] 🔧 Tool call received: ${msg.toolName} (${msg.callId})${isInvestigationTool ? ' [INVESTIGATION]' : ''}`);
        if (isInvestigationTool && msg.args && typeof msg.args === 'object' && 'objective' in msg.args) {
          logger.debug(`[gemini] 🔍 Investigation objective: ${String((msg.args as any).objective).substring(0, 150)}...`);
        }

        params.messageBuffer.addMessage(
          `Executing: ${msg.toolName}${toolArgs ? ` ${toolArgs}${toolArgs.length >= 100 ? '...' : ''}` : ''}`,
          'tool',
        );
        forwarder.forward(msg);
        break;
      }

      case 'tool-result': {
        if (
          msg.toolName === 'change_title' ||
          msg.toolName === 'happy__change_title' ||
          msg.callId?.includes('change_title') ||
          msg.toolName === 'happier__change_title'
        ) {
          params.state.changeTitleCompleted = true;
          logger.debug('[gemini] change_title completed');
        }

        const isStreamingChunk =
          !!msg.result &&
          typeof msg.result === 'object' &&
          (msg.result as any)._stream === true &&
          (typeof (msg.result as any).stdoutChunk === 'string' || typeof (msg.result as any).stderrChunk === 'string');
        const isError = msg.result && typeof msg.result === 'object' && 'error' in msg.result;
        const resultText =
          msg.result == null
            ? '(no output)'
            : typeof msg.result === 'string'
              ? msg.result.substring(0, 200)
              : JSON.stringify(msg.result).substring(0, 200);
        const truncatedResult =
          resultText + (typeof msg.result === 'string' && msg.result.length > 200 ? '...' : '');
        const resultSize =
          typeof msg.result === 'string'
            ? msg.result.length
            : msg.result == null
              ? 0
              : JSON.stringify(msg.result).length;

        logger.debug(`[gemini] ${isError ? '❌' : '✅'} Tool result received: ${msg.toolName} (${msg.callId}) - Size: ${resultSize} bytes${isError ? ' [ERROR]' : ''}`);

        if (!isError && !isStreamingChunk) {
          params.diffProcessor.processToolResult(msg.toolName, msg.result, msg.callId);
        }

        if (isStreamingChunk) {
          // Intentionally skip terminal spam for streaming chunks.
        } else if (isError) {
          const errorMsg = (msg.result as any).error || 'Tool call failed';
          logger.debug(`[gemini] ❌ Tool call error: ${errorMsg.substring(0, 300)}`);
          params.messageBuffer.addMessage(`Error: ${errorMsg}`, 'status');
        } else {
          if (resultSize > 1000) {
            logger.debug(`[gemini] ✅ Large tool result (${resultSize} bytes) - first 200 chars: ${truncatedResult}`);
          }
          params.messageBuffer.addMessage(`Result: ${truncatedResult}`, 'result');
        }

        forwarder.forward(msg);
        break;
      }

      case 'fs-edit':
        params.messageBuffer.addMessage(`File edit: ${msg.description}`, 'tool');
        params.diffProcessor.processFsEdit(msg.path || '', msg.description, msg.diff);
        forwarder.forward(msg);
        break;

      case 'terminal-output':
        if (typeof (msg as any).data === 'string' && String((msg as any).data)) {
          params.messageBuffer.addMessage(String((msg as any).data), 'result');
        }
        forwarder.forward(msg);
        break;

      case 'permission-request':
        forwarder.forward(msg);
        break;

      case 'exec-approval-request': {
        const execApprovalMsg = msg as any;
        const callId = execApprovalMsg.call_id || execApprovalMsg.callId || randomUUID();

        logger.debug(`[gemini] Exec approval request received: ${callId}`);
        params.messageBuffer.addMessage(`Exec approval requested: ${callId}`, 'tool');
        forwarder.forward(msg);
        break;
      }

      case 'patch-apply-begin': {
        const patchBeginMsg = msg as any;
        const patchCallId = patchBeginMsg.call_id || patchBeginMsg.callId || randomUUID();
        const changes = patchBeginMsg.changes;

        const changeCount = changes ? Object.keys(changes).length : 0;
        const filesMsg = changeCount === 1 ? '1 file' : `${changeCount} files`;
        params.messageBuffer.addMessage(`Modifying ${filesMsg}...`, 'tool');
        logger.debug(`[gemini] Patch apply begin: ${patchCallId}, files: ${changeCount}`);
        forwarder.forward(msg);
        break;
      }

      case 'patch-apply-end': {
        const patchEndMsg = msg as any;
        const patchEndCallId = patchEndMsg.call_id || patchEndMsg.callId || randomUUID();
        const { stdout, stderr, success } = patchEndMsg;

        if (success) {
          const message = stdout || 'Files modified successfully';
          params.messageBuffer.addMessage(message.substring(0, 200), 'result');
        } else {
          const errorMsg = stderr || 'Failed to modify files';
          params.messageBuffer.addMessage(`Error: ${errorMsg.substring(0, 200)}`, 'result');
        }
        logger.debug(`[gemini] Patch apply end: ${patchEndCallId}, success: ${success}`);
        forwarder.forward(msg);
        break;
      }

      case 'event':
        if (msg.name === 'available_commands_update') {
          const payload = msg.payload as any;
          const details = normalizeAvailableCommands(payload?.availableCommands ?? payload);
          publishSlashCommandsToMetadata({ session: params.session, details });
        }
        if (msg.name === 'thinking') {
          const thinkingPayload = msg.payload as { text?: string } | undefined;
          const thinkingText =
            thinkingPayload && typeof thinkingPayload === 'object' && 'text' in thinkingPayload
              ? String(thinkingPayload.text || '')
              : '';
          if (thinkingText) {
            logger.debug(`[gemini] 💭 Thinking chunk received: ${thinkingText.length} chars - Preview: ${thinkingText.substring(0, 100)}...`);
            if (!thinkingText.startsWith('**')) {
              const thinkingPreview = thinkingText.substring(0, 100);
              params.messageBuffer.updateLastMessage(`[Thinking] ${thinkingPreview}...`, 'system');
            }
          }
          params.session.sendAgentMessage('gemini', {
            type: 'thinking',
            text: thinkingText,
          });
        }
        break;

      default:
        if ((msg as any).type === 'token-count') {
          params.session.sendAgentMessage('gemini', {
            type: 'token_count',
            ...(msg as any),
            id: randomUUID(),
          });
        }
        break;
    }
  };
}
