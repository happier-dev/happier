import { describe, expect, it } from 'vitest';

import type { AgentMessage } from '@/agent/core/AgentMessage';
import type { AcpPermissionHandler } from '@/agent/acp/AcpBackend';
import type { AcpRuntimeSessionClient } from '@/agent/acp/sessionClient';
import { createAcpRuntime, type AcpRuntimeBackend } from '../createAcpRuntime';
import { MessageBuffer } from '@/ui/ink/messageBuffer';

function createFakeBackend() {
  let handler: ((msg: AgentMessage) => void) | null = null;
  const backend = {
    onMessage(fn: (msg: AgentMessage) => void) {
      handler = fn;
    },
    async startSession() {
      return { sessionId: 'sess_main' };
    },
    async sendPrompt(_sessionId: string, _prompt: string) {
      // noop
    },
    async waitForResponseComplete() {
      // noop
    },
    async cancel() {
      // noop
    },
    async dispose() {
      // noop
    },
    emit(msg: AgentMessage) {
      handler?.(msg);
    },
  };
  return backend as AcpRuntimeBackend & { emit: (msg: AgentMessage) => void };
}

describe('createAcpRuntime (turn hooks)', () => {
  it('invokes turn hooks and allows emitting additional tool calls before task_complete', async () => {
    const backend = createFakeBackend();
    const sent: any[] = [];

    const session: AcpRuntimeSessionClient = {
      keepAlive: () => {},
      sendAgentMessage: (_provider, body) => {
        sent.push(body);
      },
      sendAgentMessageCommitted: async (_provider, _body, _opts) => {},
      sendUserTextMessageCommitted: async (_text, _opts) => {},
      fetchRecentTranscriptTextItemsForAcpImport: async () => [],
      updateMetadata: (_handler) => {},
    };

    const permissionHandler: AcpPermissionHandler = {
      handleToolCall: async () => ({ decision: 'approved' }),
    };

    const runtime = createAcpRuntime({
      provider: 'opencode',
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler,
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
      hooks: {
        onBeginTurn: () => {
          sent.push({ type: 'hook', name: 'begin' });
        },
        onToolResult: ({ toolName }: any) => {
          sent.push({ type: 'hook', name: 'tool-result', toolName });
        },
        onBeforeFlushTurn: ({ sendToolCall, sendToolResult }: any) => {
          const callId = sendToolCall({ toolName: 'Diff', input: { files: [] } });
          sendToolResult({ callId, output: { status: 'completed' } });
        },
      },
    });

    await runtime.startOrLoad({ resumeId: null });

    runtime.beginTurn();

    backend.emit({ type: 'tool-call', toolName: 'Edit', args: { file_path: 'a.txt' }, callId: 't1' });
    backend.emit({ type: 'tool-result', toolName: 'Edit', callId: 't1', result: { ok: true } });

    runtime.flushTurn();

    const taskCompleteIdx = sent.findIndex((m) => m?.type === 'task_complete');
    expect(taskCompleteIdx).toBeGreaterThan(-1);

    const hookBeginIdx = sent.findIndex((m) => m?.type === 'hook' && m?.name === 'begin');
    expect(hookBeginIdx).toBeGreaterThan(-1);

    const hookToolResultIdx = sent.findIndex((m) => m?.type === 'hook' && m?.name === 'tool-result' && m?.toolName === 'Edit');
    expect(hookToolResultIdx).toBeGreaterThan(-1);

    const diffToolCallIdx = sent.findIndex((m) => m?.type === 'tool-call' && m?.name === 'Diff');
    const diffToolResultIdx = sent.findIndex((m) => m?.type === 'tool-result' && m?.callId && m?.output?.status === 'completed');
    expect(diffToolCallIdx).toBeGreaterThan(-1);
    expect(diffToolResultIdx).toBeGreaterThan(-1);

    expect(diffToolCallIdx).toBeLessThan(taskCompleteIdx);
    expect(diffToolResultIdx).toBeLessThan(taskCompleteIdx);
  });

  it('clears in-flight turn state on cancel', async () => {
    const backend = createFakeBackend();

    const session: AcpRuntimeSessionClient = {
      keepAlive: () => {},
      sendAgentMessage: () => {},
      sendAgentMessageCommitted: async () => {},
      sendUserTextMessageCommitted: async () => {},
      fetchRecentTranscriptTextItemsForAcpImport: async () => [],
      updateMetadata: () => {},
    };

    const permissionHandler: AcpPermissionHandler = {
      handleToolCall: async () => ({ decision: 'approved' }),
    };

    const runtime = createAcpRuntime({
      provider: 'opencode',
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler,
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
    });

    await runtime.startOrLoad({ resumeId: null });

    runtime.beginTurn();
    expect(runtime.isTurnInFlight()).toBe(true);

    await runtime.cancel();
    expect(runtime.isTurnInFlight()).toBe(false);
  });
});
