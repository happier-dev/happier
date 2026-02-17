import type { ACPMessageData, ACPProvider } from '@/api/session/sessionMessageTypes';
import type { AgentMessage } from '@/agent/core';
import { buildTokenCountSessionMessageForForwarding } from '@/agent/acp/runtime/tokenCountForwarding';
import {
  forwardAcpToolCall,
  forwardAcpToolResult,
  namespaceSidechainCallId,
  type AcpSendFn,
} from '@/agent/acp/bridge/acpSessionForwarding';
import { normalizePermissionRequestOptionsForAcp } from '@/agent/acp/bridge/acpCommonHandlers';

type SendAcpLike = AcpSendFn;

export function createAcpAgentMessageForwarder(params: {
  sendAcp: SendAcpLike;
  provider: ACPProvider;
  sidechainId?: string;
  makeId: () => string;
}): {
  forward: (msg: AgentMessage) => void;
} {
  const sidechainId = params.sidechainId;
  const ns = (toolCallId: string): string =>
    sidechainId ? namespaceSidechainCallId({ sidechainId, toolCallId }) : toolCallId;

  // `terminal-output` ACP messages are normalized into tool-results in the UI. Emit a synthetic tool-call once so
  // the tool-results are always renderable (no orphan tool results).
  const terminalToolCallId = ns('happier:terminal-output');
  let terminalToolCallSent = false;

  const send = (body: ACPMessageData): void => {
    params.sendAcp(params.provider, body);
  };

  const withSidechain = <T extends Record<string, unknown>>(body: T): T | (T & { sidechainId: string }) => {
    return sidechainId ? ({ ...body, sidechainId } as any) : body;
  };

  const ensureTerminalToolCall = (): void => {
    if (terminalToolCallSent) return;
    terminalToolCallSent = true;
    forwardAcpToolCall({
      sendAcp: params.sendAcp,
      provider: params.provider,
      callId: terminalToolCallId,
      toolName: 'terminal-output',
      input: {},
      id: params.makeId(),
      ...(sidechainId ? { sidechainId } : {}),
    });
  };

  const forward = (msg: AgentMessage): void => {
    switch (msg.type) {
      case 'event':
      case 'status':
      case 'permission-response':
      case 'model-output':
        return;

      case 'tool-call':
        forwardAcpToolCall({
          sendAcp: params.sendAcp,
          provider: params.provider,
          callId: ns(msg.callId),
          toolName: msg.toolName,
          input: msg.args,
          id: params.makeId(),
          ...(sidechainId ? { sidechainId } : {}),
        });
        return;

      case 'tool-result':
        forwardAcpToolResult({
          sendAcp: params.sendAcp,
          provider: params.provider,
          callId: ns(msg.callId),
          output: msg.result,
          id: params.makeId(),
          ...(sidechainId ? { sidechainId } : {}),
        });
        return;

      case 'permission-request': {
        const payload = ((msg as any).payload ?? {}) as any;
        send(
          withSidechain({
            type: 'permission-request',
            permissionId: ns(String((msg as any).id ?? params.makeId())),
            toolName: payload?.toolName || (msg as any).reason || 'unknown',
            description: (msg as any).reason || payload?.toolName || '',
            options: normalizePermissionRequestOptionsForAcp(payload),
          }),
        );
        return;
      }

      case 'terminal-output': {
        const data = typeof (msg as any).data === 'string' ? String((msg as any).data) : '';
        if (!data) return;
        ensureTerminalToolCall();
        send(
          withSidechain({
            type: 'terminal-output',
            data,
            callId: terminalToolCallId,
          }),
        );
        return;
      }

      case 'fs-edit': {
        const description = typeof (msg as any).description === 'string' ? String((msg as any).description) : '';
        const filePath =
          typeof (msg as any).path === 'string' && String((msg as any).path).trim()
            ? String((msg as any).path).trim()
            : 'unknown';
        const diff = typeof (msg as any).diff === 'string' ? String((msg as any).diff) : undefined;
        send(
          withSidechain({
            type: 'file-edit',
            description,
            filePath,
            ...(diff ? { diff } : {}),
            id: params.makeId(),
          }),
        );
        return;
      }

      case 'token-count': {
        const tokenCount = buildTokenCountSessionMessageForForwarding(msg as any);
        if (!tokenCount) return;
        send(withSidechain({ ...tokenCount, id: params.makeId() } as any));
        return;
      }

      case 'exec-approval-request': {
        const execApprovalMsg = msg as any;
        const callId = ns(String(execApprovalMsg.call_id ?? execApprovalMsg.callId ?? params.makeId()));
        const { call_id, type, ...inputs } = execApprovalMsg;
        forwardAcpToolCall({
          sendAcp: params.sendAcp,
          provider: params.provider,
          callId,
          toolName: 'exec',
          input: inputs,
          id: params.makeId(),
          ...(sidechainId ? { sidechainId } : {}),
        });
        return;
      }

      case 'patch-apply-begin': {
        const patchBeginMsg = msg as any;
        const callId = ns(String(patchBeginMsg.call_id ?? patchBeginMsg.callId ?? params.makeId()));
        forwardAcpToolCall({
          sendAcp: params.sendAcp,
          provider: params.provider,
          callId,
          toolName: 'patch',
          input: {
            autoApproved: patchBeginMsg.auto_approved,
            changes: patchBeginMsg.changes,
          },
          id: params.makeId(),
          ...(sidechainId ? { sidechainId } : {}),
        });
        return;
      }

      case 'patch-apply-end': {
        const patchEndMsg = msg as any;
        const callId = ns(String(patchEndMsg.call_id ?? patchEndMsg.callId ?? params.makeId()));
        forwardAcpToolResult({
          sendAcp: params.sendAcp,
          provider: params.provider,
          callId,
          output: {
            success: Boolean(patchEndMsg.success),
            stdout: patchEndMsg.stdout,
            stderr: patchEndMsg.stderr,
          },
          isError: patchEndMsg.success === false ? true : undefined,
          id: params.makeId(),
          ...(sidechainId ? { sidechainId } : {}),
        });
        return;
      }

      default:
        return;
    }
  };

  return { forward };
}

