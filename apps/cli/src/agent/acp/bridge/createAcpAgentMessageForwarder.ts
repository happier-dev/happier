import type { ACPMessageData, ACPProvider } from '@/api/session/sessionMessageTypes';
import type { AgentMessage } from '@/agent/core';
import { buildTokenCountSessionMessageForForwarding } from '@/agent/acp/runtime/tokenCountForwarding';
import {
  namespaceSidechainCallId,
  type AcpSendFn,
} from '@/agent/acp/bridge/acpSessionForwarding';
import { normalizePermissionRequestOptionsForAcp } from '@/agent/acp/bridge/acpCommonHandlers';
import { extractThinkingTextFromThinkToolInput, isThinkingToolName } from '@/agent/acp/bridge/thinkingToolCall';
import { createAcpToolCallRevisionPublisher } from './AcpToolCallRevisionPublisher';

type SendAcpLike = AcpSendFn;

export function createAcpAgentMessageForwarder(params: {
  sendAcp: SendAcpLike;
  provider: ACPProvider;
  sidechainId?: string;
  /**
   * Keep provider call ids un-namespaced inside the sidechain. Only for providers whose call ids are
   * already unique across the main thread and every subagent thread, so permission prompts keep the
   * id the permission handler registered.
   */
  preserveProviderCallIds?: boolean;
  makeId: () => string;
}): {
  forward: (msg: AgentMessage) => void;
  dispose: () => void;
} {
  const sidechainId = params.sidechainId;
  const ns = (toolCallId: string): string =>
    sidechainId && !params.preserveProviderCallIds ? namespaceSidechainCallId({ sidechainId, toolCallId }) : toolCallId;
  const toolPublisher = createAcpToolCallRevisionPublisher({
    provider: params.provider,
    namespace: sidechainId ? { type: 'sidechain', sidechainId } : { type: 'main' },
    sendAcp: params.sendAcp,
  });

  // `terminal-output` ACP messages are normalized into tool-results in the UI. Emit a synthetic tool-call once so
  // the tool-results are always renderable (no orphan tool results).
  const terminalToolCallId = ns('happier:terminal-output');
  let terminalToolCallSent = false;
  const suppressedThinkToolCallIds = new Set<string>();
  let disposed = false;

  const send = (body: ACPMessageData): void => {
    params.sendAcp(params.provider, body);
  };

  const withSidechain = <T extends Record<string, unknown>>(body: T): T | (T & { sidechainId: string }) => {
    return sidechainId ? ({ ...body, sidechainId } as any) : body;
  };

  const readToolSnapshotLifecycle = (input: unknown): Readonly<{
    revision?: number;
  }> => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
    const acp = (input as { _acp?: unknown })._acp;
    if (!acp || typeof acp !== 'object' || Array.isArray(acp)) return {};
    const revision = (acp as { snapshotRevision?: unknown }).snapshotRevision;
    return {
      ...(typeof revision === 'number' && Number.isSafeInteger(revision) && revision > 0
        ? { revision }
        : {}),
    };
  };

  const ensureTerminalToolCall = (): void => {
    if (terminalToolCallSent) return;
    terminalToolCallSent = true;
    toolPublisher.publishCall({
      callId: terminalToolCallId,
      toolName: 'terminal-output',
      input: {},
      ...(sidechainId ? { sidechainId } : {}),
    });
  };

  const forward = (msg: AgentMessage): void => {
    if (disposed) return;
    switch (msg.type) {
      case 'event':
      case 'status':
      case 'permission-response':
      case 'model-output':
        return;

      case 'tool-call':
        if (isThinkingToolName(msg.toolName)) {
          const callId = ns(msg.callId);
          suppressedThinkToolCallIds.add(callId);
          const text = extractThinkingTextFromThinkToolInput(msg.args);
          if (text) {
            send(withSidechain({ type: 'thinking', text }));
          }
          return;
        }
        const lifecycle = readToolSnapshotLifecycle(msg.args);
        toolPublisher.publishCall({
          callId: ns(msg.callId),
          toolName: msg.toolName,
          input: msg.args,
          ...lifecycle,
          ...(sidechainId ? { sidechainId } : {}),
        });
        return;

      case 'tool-result':
        if (suppressedThinkToolCallIds.has(ns(msg.callId))) {
          suppressedThinkToolCallIds.delete(ns(msg.callId));
          return;
        }
        toolPublisher.publishResult({
          callId: ns(msg.callId),
          toolName: msg.toolName,
          output: msg.result,
          ...(typeof (msg as any).isError === 'boolean' ? { isError: (msg as any).isError } : {}),
          ...(sidechainId ? { sidechainId } : {}),
          ...(msg.meta ? { meta: msg.meta } : {}),
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
        toolPublisher.publishCall({
          callId,
          toolName: 'exec',
          input: inputs,
          ...(sidechainId ? { sidechainId } : {}),
        });
        return;
      }

      case 'patch-apply-begin': {
        const patchBeginMsg = msg as any;
        const callId = ns(String(patchBeginMsg.call_id ?? patchBeginMsg.callId ?? params.makeId()));
        toolPublisher.publishCall({
          callId,
          toolName: 'patch',
          input: {
            autoApproved: patchBeginMsg.auto_approved,
            changes: patchBeginMsg.changes,
          },
          ...(sidechainId ? { sidechainId } : {}),
        });
        return;
      }

      case 'patch-apply-end': {
        const patchEndMsg = msg as any;
        const callId = ns(String(patchEndMsg.call_id ?? patchEndMsg.callId ?? params.makeId()));
        toolPublisher.publishResult({
          callId,
          toolName: 'patch',
          output: {
            success: Boolean(patchEndMsg.success),
            stdout: patchEndMsg.stdout,
            stderr: patchEndMsg.stderr,
          },
          isError: patchEndMsg.success === false ? true : undefined,
          ...(sidechainId ? { sidechainId } : {}),
        });
        return;
      }

      default:
        return;
    }
  };

  return {
    forward,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      suppressedThinkToolCallIds.clear();
      toolPublisher.dispose();
    },
  };
}
