import { randomUUID } from 'node:crypto';

import type { AgentMessage, SessionId, ToolCallId } from '@/agent/core';
import type { PermissionMode } from '@/api/types';
import type { ExecutionRunHostRuntime } from '@/agent/runtime/bridges/executionRun/executionRunHostRuntime';
import { CodexMcpClient } from '@/backends/codex/mcp/sessionClient';
import type { CodexToolResponse } from '@/backends/codex/mcp/types';
import { extractCodexToolErrorText } from '@/backends/codex/runtime/sessionTurnLifecycle';
import { buildCodexMcpStartConfig } from '@/backends/codex/utils/buildCodexMcpStartConfig';
import { resolveCodexMcpPolicyForPermissionMode } from '@/backends/codex/utils/permissionModePolicy';

function resolveMessageDelta(nextText: string, previousText: string): string {
  if (nextText.startsWith(previousText)) {
    return nextText.slice(previousText.length);
  }
  return nextText;
}

export function mcpBackend(args: Readonly<{
  cwd: string;
  env?: NodeJS.ProcessEnv;
  modelId?: string;
  permissionMode: PermissionMode;
}>): ExecutionRunHostRuntime {
  const client = new CodexMcpClient({ env: args.env });
  const handlers = new Set<(message: AgentMessage) => void>();
  let backendSessionId: SessionId | null = null;
  let vendorSessionId: SessionId | null = null;
  let reportedVendorSessionId: SessionId | null = null;
  let currentAbortController: AbortController | null = null;
  let inFlightToolCall: Promise<CodexToolResponse> | null = null;
  let responseSettled = true;
  let responseWaiter:
    | null
    | {
        promise: Promise<void>;
        resolve: () => void;
        reject: (error: Error) => void;
      } = null;
  let lastAssistantText = '';
  let fallbackCallIdCounter = 0;
  const pendingFallbackCallIds: string[] = [];

  const emit = (message: AgentMessage) => {
    for (const handler of handlers) {
      handler(message);
    }
  };

  const syncVendorSessionIdFromClient = (): SessionId => {
    const nextVendorSessionId = client.getSessionId();
    if (!nextVendorSessionId) {
      throw new Error('Codex MCP session did not return a session id');
    }
    vendorSessionId = nextVendorSessionId as SessionId;
    if (backendSessionId && backendSessionId !== vendorSessionId && reportedVendorSessionId !== vendorSessionId) {
      reportedVendorSessionId = vendorSessionId;
      emit({ type: 'event', name: 'vendor_session_id', payload: { sessionId: vendorSessionId } });
    }
    return vendorSessionId;
  };

  const syncVendorSessionIdFromClientIfPresent = (): SessionId | null => {
    const nextVendorSessionId = client.getSessionId();
    if (!nextVendorSessionId) {
      return vendorSessionId;
    }
    return syncVendorSessionIdFromClient();
  };

  const waitForPreviousToolCall = async (): Promise<void> => {
    if (!inFlightToolCall) return;
    try {
      await inFlightToolCall;
    } catch {
      // The next turn is allowed to proceed after the previous call settles, even if it failed or was aborted.
    }
  };

  const runSerializedToolCall = async (call: () => Promise<CodexToolResponse>): Promise<CodexToolResponse> => {
    await waitForPreviousToolCall();
    const toolCallPromise = call();
    inFlightToolCall = toolCallPromise;
    try {
      return await toolCallPromise;
    } finally {
      if (inFlightToolCall === toolCallPromise) {
        inFlightToolCall = null;
      }
    }
  };

  const resetResponseWaiter = () => {
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    responseSettled = false;
    responseWaiter = { promise, resolve, reject };
  };

  const settleResponseWaiter = (error?: Error) => {
    if (!responseWaiter || responseSettled) return;
    responseSettled = true;
    const waiter = responseWaiter;
    responseWaiter = null;
    currentAbortController = null;
    if (error) {
      waiter.reject(error);
      return;
    }
    waiter.resolve();
  };

  const buildStartConfig = (prompt: string) => {
    // For Happier's 'default' mode, omit sandbox/approvalPolicy so the Codex MCP subprocess
    // falls back to ~/.codex/config.toml. Non-default modes still override via start params.
    const policy =
      args.permissionMode === 'default'
        ? { approvalPolicy: null as null, sandbox: null as null }
        : resolveCodexMcpPolicyForPermissionMode(args.permissionMode);
    return buildCodexMcpStartConfig({
      prompt,
      cwd: args.cwd,
      sandbox: policy.sandbox,
      approvalPolicy: policy.approvalPolicy,
      mcpServers: {},
      ...(typeof args.modelId === 'string' && args.modelId.trim() ? { model: args.modelId.trim() } : {}),
    });
  };

  const createFallbackCallId = (): ToolCallId => {
    fallbackCallIdCounter += 1;
    return `codex_tool_${fallbackCallIdCounter}` as ToolCallId;
  };

  const resolveBeginCallId = (rawCallId: unknown): ToolCallId => {
    const callId = String(rawCallId ?? '');
    if (callId) return callId as ToolCallId;
    const fallbackCallId = createFallbackCallId();
    pendingFallbackCallIds.push(fallbackCallId);
    return fallbackCallId;
  };

  const resolveEndCallId = (rawCallId: unknown): ToolCallId => {
    const callId = String(rawCallId ?? '');
    if (callId) return callId as ToolCallId;
    return (pendingFallbackCallIds.shift() ?? createFallbackCallId()) as ToolCallId;
  };

  client.setHandler((raw: unknown) => {
    const message = raw as any;
    switch (message?.type) {
      case 'task_started':
        lastAssistantText = '';
        emit({ type: 'status', status: 'running' });
        break;
      case 'task_complete':
        emit({ type: 'status', status: 'idle' });
        settleResponseWaiter();
        break;
      case 'turn_aborted':
        emit({ type: 'status', status: 'idle', detail: 'turn_aborted' });
        settleResponseWaiter();
        break;
      case 'agent_message': {
        const fullText = typeof message.message === 'string' ? message.message : '';
        if (!fullText) break;
        const textDelta = resolveMessageDelta(fullText, lastAssistantText);
        lastAssistantText = fullText;
        emit({
          type: 'model-output',
          ...(textDelta ? { textDelta } : {}),
          fullText,
        });
        break;
      }
      case 'exec_command_begin': {
        const toolName = 'CodexBash';
        emit({
          type: 'tool-call',
          toolName,
          args: typeof message === 'object' && message ? { ...message } : {},
          callId: resolveBeginCallId(message.call_id ?? message.callId),
        });
        break;
      }
      case 'exec_command_end': {
        emit({
          type: 'tool-result',
          toolName: 'CodexBash',
          result: typeof message === 'object' && message ? { ...message } : message,
          callId: resolveEndCallId(message.call_id ?? message.callId),
          isError: Boolean(message?.error),
        });
        break;
      }
      default:
        break;
    }
  });

  const provisionSession = async (opts?: Readonly<{
    initialPrompt?: string;
    resumeSessionId?: string;
    captureReplay?: boolean;
  }>): Promise<{ sessionId: string }> => {
      const resumeSessionId = typeof opts?.resumeSessionId === 'string' && opts.resumeSessionId.trim().length > 0
        ? opts.resumeSessionId.trim() as SessionId
        : null;
      if (resumeSessionId) {
        if (opts?.captureReplay === true) {
          throw new Error('Backend does not support resumable long-lived runs');
        }
        client.setThreadIdForResume(resumeSessionId);
        backendSessionId = resumeSessionId;
        vendorSessionId = resumeSessionId;
        reportedVendorSessionId = resumeSessionId;
        return { sessionId: resumeSessionId };
      }

      const prompt = typeof opts?.initialPrompt === 'string' ? opts.initialPrompt : '';
      if (!prompt.trim()) {
        backendSessionId = `codex_mcp_execution_run_${randomUUID()}` as SessionId;
        vendorSessionId = null;
        reportedVendorSessionId = null;
        return { sessionId: backendSessionId };
      }

      const response = await client.startSession(
        buildStartConfig(prompt),
      );
      const startError = extractCodexToolErrorText(response);
      if (startError) {
        throw new Error(startError);
      }
      backendSessionId = syncVendorSessionIdFromClient();
      return { sessionId: backendSessionId };
  };

  return Object.freeze({
    async readResumeSupport(opts) {
      return opts?.captureReplay === true ? false : true;
    },
    provisionSession,
    async sendPrompt(sessionId: SessionId, prompt: string): Promise<void> {
      lastAssistantText = '';
      resetResponseWaiter();

      const isKnownSession = sessionId === backendSessionId || sessionId === vendorSessionId;
      if (!backendSessionId) {
        backendSessionId = sessionId;
      } else if (!isKnownSession) {
        client.setThreadIdForResume(sessionId);
        backendSessionId = sessionId;
        vendorSessionId = sessionId;
        reportedVendorSessionId = sessionId;
      }

      syncVendorSessionIdFromClientIfPresent();
      let toolCallWasAborted = false;
      const response = await runSerializedToolCall(async () => {
        const abortController = new AbortController();
        abortController.signal.addEventListener(
          'abort',
          () => {
            toolCallWasAborted = true;
          },
          { once: true },
        );
        currentAbortController = abortController;
        return await (vendorSessionId
          ? client.continueSession(prompt, { signal: abortController.signal })
          : client.startSession(buildStartConfig(prompt), { signal: abortController.signal }));
      });
      const sendError = extractCodexToolErrorText(response);
      if (sendError) {
        settleResponseWaiter(new Error(sendError));
        throw new Error(sendError);
      }
      if (!toolCallWasAborted && !vendorSessionId) {
        syncVendorSessionIdFromClient();
      }
    },
    async cancel(_sessionId: SessionId): Promise<void> {
      currentAbortController?.abort();
      settleResponseWaiter();
    },
    subscribeMessages(handler) {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
    async waitForTurnCompletion(timeoutMs?: number | null): Promise<void> {
      if (!responseWaiter || responseSettled) return;
      if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        await responseWaiter.promise;
        return;
      }
      await Promise.race([
        responseWaiter.promise,
        new Promise<void>((_, reject) => {
          const timeout = setTimeout(() => {
            clearTimeout(timeout);
            reject(new Error(`Codex MCP response timeout after ${timeoutMs}ms`));
          }, timeoutMs);
          responseWaiter?.promise.finally(() => clearTimeout(timeout));
        }),
      ]);
    },
    async dispose(): Promise<void> {
      settleResponseWaiter();
      backendSessionId = null;
      vendorSessionId = null;
      reportedVendorSessionId = null;
      await client.forceCloseSession();
    },
  });
}
