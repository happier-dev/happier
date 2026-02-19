import { randomUUID } from 'node:crypto';

import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { ACPMessageData } from '@/api/session/sessionMessageTypes';
import { MessageBuffer } from '@/ui/ink/messageBuffer';

import { nextCodexLifecycleAcpMessages } from '../utils/codexAcpLifecycle';
import { formatCodexEventForUi } from '../utils/formatCodexEventForUi';
import { extractMcpToolCallResultOutput } from './sessionTurnLifecycle';

type SessionSubset = Pick<
  ApiSessionClient,
  'sendAgentMessage' | 'sendCodexMessage' | 'sendSessionEvent' | 'keepAlive'
>;

type DiffProcessorSubset = {
  processDiff: (diffText: string) => void;
};

type LoggerSubset = {
  debug: (message: string, ...args: unknown[]) => void;
};

type UiForwarderDeps = {
  messageBuffer: Pick<MessageBuffer, 'addMessage'>;
  session: Pick<ApiSessionClient, 'sendSessionEvent'>;
};

export function forwardCodexStatusToUi(opts: UiForwarderDeps & { messageText: string }): void {
  opts.messageBuffer.addMessage(opts.messageText, 'status');
  opts.session.sendSessionEvent({ type: 'message', message: opts.messageText });
}

export function forwardCodexErrorToUi(opts: UiForwarderDeps & { errorText: string }): void {
  const text = typeof opts.errorText === 'string' ? opts.errorText.trim() : '';
  if (!text || text === 'Codex error') {
    forwardCodexStatusToUi({ ...opts, messageText: 'Codex error' });
    return;
  }
  forwardCodexStatusToUi({ ...opts, messageText: `Codex error: ${text}` });
}

export function createCodexMcpMessageHandler(opts: {
  logger: LoggerSubset;
  session: SessionSubset;
  messageBuffer: Pick<MessageBuffer, 'addMessage'>;
  sendReady: () => void;
  publishCodexThreadIdToMetadata: () => void;
  diffProcessor: DiffProcessorSubset;
  getCurrentTaskId: () => string | null;
  setCurrentTaskId: (next: string | null) => void;
  getThinking: () => boolean;
  setThinking: (next: boolean) => void;
}): (msg: unknown) => void {
  let accumulatedReasoning = '';
  let sawReasoningDelta = false;

  return (msg: unknown): void => {
    opts.logger.debug(`[Codex] MCP message: ${JSON.stringify(msg)}`);

    opts.publishCodexThreadIdToMetadata();

    const lifecycle = nextCodexLifecycleAcpMessages({
      currentTaskId: opts.getCurrentTaskId(),
      msg,
    });
    opts.setCurrentTaskId(lifecycle.currentTaskId);
    for (const event of lifecycle.messages) {
      opts.session.sendAgentMessage('codex', event as ACPMessageData);
    }

    const uiText = formatCodexEventForUi(msg);
    if (uiText) {
      forwardCodexStatusToUi({
        messageBuffer: opts.messageBuffer,
        session: opts.session,
        messageText: uiText,
      });
    }

    const message = msg as any;
    if (message?.type === 'agent_message') {
      opts.messageBuffer.addMessage(message.message, 'assistant');
    } else if (message?.type === 'agent_reasoning') {
      opts.messageBuffer.addMessage(`[Thinking] ${message.text.substring(0, 100)}...`, 'system');
    } else if (message?.type === 'exec_command_begin') {
      opts.messageBuffer.addMessage(`Executing: ${message.command}`, 'tool');
    } else if (message?.type === 'exec_command_end') {
      const output = message.output || message.error || 'Command completed';
      const truncatedOutput = output.substring(0, 200);
      opts.messageBuffer.addMessage(
        `Result: ${truncatedOutput}${output.length > 200 ? '...' : ''}`,
        'result',
      );
    } else if (message?.type === 'task_started') {
      opts.messageBuffer.addMessage('Starting task...', 'status');
    } else if (message?.type === 'task_complete') {
      opts.messageBuffer.addMessage('Task completed', 'status');
      opts.sendReady();
    } else if (message?.type === 'turn_aborted') {
      opts.messageBuffer.addMessage('Turn aborted', 'status');
      opts.sendReady();
    }

    if (message?.type === 'task_started') {
      if (!opts.getThinking()) {
        opts.logger.debug('thinking started');
        opts.setThinking(true);
        opts.session.keepAlive(true, 'remote');
      }
    }
    if (message?.type === 'task_complete' || message?.type === 'turn_aborted') {
      if (opts.getThinking()) {
        opts.logger.debug('thinking completed');
        opts.setThinking(false);
        opts.session.keepAlive(false, 'remote');
      }
    }

    if (message?.type === 'agent_reasoning_section_break') {
      if (accumulatedReasoning) {
        opts.session.sendAgentMessage('codex', { type: 'thinking', text: '\n\n' });
      }
      accumulatedReasoning = '';
      sawReasoningDelta = false;
    }
    if (message?.type === 'agent_reasoning_delta') {
      const delta = typeof message.delta === 'string' ? message.delta : '';
      // Preserve whitespace-only deltas for correct transcript rendering.
      opts.session.sendAgentMessage('codex', { type: 'thinking', text: delta });
      accumulatedReasoning += delta;
      if (delta.length > 0) sawReasoningDelta = true;
    }
    if (message?.type === 'agent_reasoning') {
      const full = typeof message.text === 'string' ? message.text : '';
      if (full) {
        if (!sawReasoningDelta) {
          opts.session.sendAgentMessage('codex', { type: 'thinking', text: full });
        } else if (accumulatedReasoning && full.startsWith(accumulatedReasoning)) {
          const suffix = full.slice(accumulatedReasoning.length);
          if (suffix) {
            opts.session.sendAgentMessage('codex', { type: 'thinking', text: suffix });
          }
        } else if (accumulatedReasoning && full !== accumulatedReasoning) {
          // Defensive fallback: if deltas don't match the final payload, surface the final text
          // rather than losing reasoning content.
          opts.session.sendAgentMessage('codex', { type: 'thinking', text: '\n\n' });
          opts.session.sendAgentMessage('codex', { type: 'thinking', text: full });
        }
      }
      accumulatedReasoning = '';
      sawReasoningDelta = false;
    }
    if (message?.type === 'agent_message') {
      opts.session.sendCodexMessage({
        type: 'message',
        message: message.message,
        id: randomUUID(),
      });
    }
    if (message?.type === 'exec_command_begin' || message?.type === 'exec_approval_request') {
      const { call_id, type, ...inputs } = message;
      opts.session.sendCodexMessage({
        type: 'tool-call',
        name: 'CodexBash',
        callId: call_id,
        input: inputs,
        id: randomUUID(),
      });
    }
    if (message?.type === 'exec_command_end') {
      const { call_id, type, ...output } = message;
      opts.session.sendCodexMessage({
        type: 'tool-call-result',
        callId: call_id,
        output,
        id: randomUUID(),
      });
    }
    if (message?.type === 'token_count') {
      opts.session.sendCodexMessage({
        ...message,
        id: randomUUID(),
      });
    }
    if (message?.type === 'patch_apply_begin') {
      const { call_id, auto_approved, changes } = message;
      const changeCount = Object.keys(changes).length;
      const filesMsg = changeCount === 1 ? '1 file' : `${changeCount} files`;
      opts.messageBuffer.addMessage(`Modifying ${filesMsg}...`, 'tool');
      opts.session.sendCodexMessage({
        type: 'tool-call',
        name: 'CodexPatch',
        callId: call_id,
        input: {
          auto_approved,
          changes,
        },
        id: randomUUID(),
      });
    }
    if (message?.type === 'patch_apply_end') {
      const { call_id, stdout, stderr, success } = message;
      if (success) {
        const text = stdout || 'Files modified successfully';
        opts.messageBuffer.addMessage(text.substring(0, 200), 'result');
      } else {
        const errorMsg = stderr || 'Failed to modify files';
        opts.messageBuffer.addMessage(`Error: ${errorMsg.substring(0, 200)}`, 'result');
      }
      opts.session.sendCodexMessage({
        type: 'tool-call-result',
        callId: call_id,
        output: {
          stdout,
          stderr,
          success,
        },
        id: randomUUID(),
      });
    }
    if (message?.type === 'turn_diff' && message.unified_diff) {
      opts.diffProcessor.processDiff(message.unified_diff);
    }
    if (message?.type === 'mcp_tool_call_begin') {
      const { call_id, invocation } = message;
      const toolName = `mcp__${invocation.server}__${invocation.tool}`;
      opts.session.sendCodexMessage({
        type: 'tool-call',
        name: toolName,
        callId: call_id,
        input: invocation.arguments || {},
        id: randomUUID(),
      });
    }
    if (message?.type === 'mcp_tool_call_end') {
      const { call_id, result } = message;
      const output = extractMcpToolCallResultOutput(result);
      opts.session.sendCodexMessage({
        type: 'tool-call-result',
        callId: call_id,
        output,
        id: randomUUID(),
      });
    }
  };
}
