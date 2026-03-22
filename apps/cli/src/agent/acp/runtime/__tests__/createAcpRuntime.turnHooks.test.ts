import { describe, expect, it } from 'vitest';

import { createFakeAcpRuntimeBackend } from '@/testkit/backends/acpRuntimeBackend';
import { createApprovedPermissionHandler } from '@/testkit/backends/permissionHandler';
import { createBasicSessionClient, createBasicSessionClientWithOverrides } from '@/testkit/backends/sessionFixtures';
import { createAcpRuntime } from '../createAcpRuntime';
import { MessageBuffer } from '@/ui/ink/messageBuffer';

describe('createAcpRuntime (turn hooks)', () => {
  it('invokes turn hooks and allows emitting additional tool calls before task_complete', async () => {
    const backend = createFakeAcpRuntimeBackend();
    const sent: any[] = [];

    const session = createBasicSessionClientWithOverrides({
      sendAgentMessage: (_provider, body) => {
        sent.push(body);
      },
    });

    const runtime = createAcpRuntime({
      provider: 'opencode',
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
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

    await runtime.flushTurn();

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

  it('treats think tool calls as thinking (does not invoke onToolResult)', async () => {
    const backend = createFakeAcpRuntimeBackend();
    const sent: any[] = [];

    const session = createBasicSessionClientWithOverrides({
      sendAgentMessage: (_provider, body) => {
        sent.push(body);
      },
    });

    const runtime = createAcpRuntime({
      provider: 'opencode',
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
      hooks: {
        onToolResult: ({ toolName }: any) => {
          sent.push({ type: 'hook', name: 'tool-result', toolName });
        },
      },
    });

    await runtime.startOrLoad({ resumeId: null });

    runtime.beginTurn();
    backend.emit({ type: 'tool-call', toolName: 'think', args: { thinking: 'Hello' }, callId: 't1' });
    backend.emit({ type: 'tool-result', toolName: 'think', callId: 't1', result: { ok: true } });
    await runtime.flushTurn();

    expect(sent.some((m) => m?.type === 'tool-call' && String(m?.name ?? '').toLowerCase() === 'think')).toBe(false);
    expect(sent.some((m) => m?.type === 'tool-result' && m?.callId === 't1')).toBe(false);
    expect(sent).toContainEqual({ type: 'thinking', text: 'Hello' });
    expect(sent.some((m) => m?.type === 'hook' && m?.name === 'tool-result' && m?.toolName === 'think')).toBe(false);
  });

  it('clears in-flight turn state on cancel', async () => {
    const backend = createFakeAcpRuntimeBackend();

    const runtime = createAcpRuntime({
      provider: 'opencode',
      directory: '/tmp',
      session: createBasicSessionClient(),
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
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
