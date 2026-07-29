import { describe, expect, it, vi } from 'vitest';
import { RuntimeEventV1Schema, type RuntimeEventV1 } from '@happier-dev/protocol';

import { createFakeAcpRuntimeBackend } from '@/testkit/backends/acpRuntimeBackend';
import { createApprovedPermissionHandler } from '@/testkit/backends/permissionHandler';
import { createBasicSessionClient, createBasicSessionClientWithOverrides } from '@/testkit/backends/sessionFixtures';
import { createAcpRuntime } from '../createAcpRuntime';
import { MessageBuffer } from '@/ui/ink/messageBuffer';

describe('createAcpRuntime (turn hooks)', () => {
  function collectRuntimeEvents(runtime: Readonly<{
    subscribeRuntimeEvents: (handler: (message: unknown) => void) => () => void;
  }>): RuntimeEventV1[] {
    const events: RuntimeEventV1[] = [];
    runtime.subscribeRuntimeEvents((message) => {
      events.push(RuntimeEventV1Schema.parse(message));
    });
    return events;
  }

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

    await runtime.sendTurnPrompt('session setup');

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

  it('uses one provider turn id for running and completion without the legacy primary-turn writer', async () => {
    const backend = createFakeAcpRuntimeBackend();
    const sent: any[] = [];

    const session = createBasicSessionClientWithOverrides({
      sendAgentMessage: (_provider, body) => {
        sent.push(body);
      },
    });

    const runtime = createAcpRuntime({
      provider: 'pi',
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
    });
    const runtimeEvents = collectRuntimeEvents(runtime);

    await runtime.sendTurnPrompt('session setup');
    runtime.beginTurn();
    backend.emit({ type: 'status', status: 'running' });
    backend.emit({ type: 'model-output', textDelta: 'hello' });
    await runtime.flushTurn();

    const taskStarted = sent.find((message) => message?.type === 'task_started');
    const taskComplete = sent.find((message) => message?.type === 'task_complete');

    expect(taskStarted?.id).toEqual(expect.any(String));
    expect(taskComplete?.id).toBe(taskStarted.id);
    const turnStart = runtimeEvents.find((event) => event.kind === 'turn-start');
    expect(turnStart).toEqual(expect.objectContaining({
      kind: 'turn-start',
      agentTurnId: taskStarted.id,
    }));
    expect(runtimeEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'turn-complete',
        turnId: turnStart?.turnId,
        agentTurnId: taskStarted.id,
      }),
    ]));
  });

  it('uses the active provider turn id when status errors fail a typed turn', async () => {
    const backend = createFakeAcpRuntimeBackend();
    const sent: any[] = [];

    const session = createBasicSessionClientWithOverrides({
      sendAgentMessage: (_provider, body) => {
        sent.push(body);
      },
    });

    const runtime = createAcpRuntime({
      provider: 'pi',
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
    });
    const runtimeEvents = collectRuntimeEvents(runtime);

    await runtime.sendTurnPrompt('session setup');
    runtime.beginTurn();
    backend.emit({ type: 'status', status: 'running' });
    const taskStarted = sent.find((message) => message?.type === 'task_started');
    backend.emit({ type: 'status', status: 'error', detail: 'provider failed' });

    await vi.waitFor(() => {
      expect(sent.some((message) => message?.type === 'turn_failed')).toBe(true);
    });
    const turnFailed = sent.find((message) => message?.type === 'turn_failed');

    expect(taskStarted?.id).toEqual(expect.any(String));
    expect(turnFailed?.id).toBe(taskStarted.id);
    const turnStart = runtimeEvents.find((event) => event.kind === 'turn-start');
    await vi.waitFor(() => {
      expect(runtimeEvents).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: 'turn-failed',
          turnId: turnStart?.turnId,
          agentTurnId: taskStarted.id,
        }),
      ]));
    });
  });

  it('does not wait on legacy primary-turn projection before flushTurn resolves', async () => {
    const backend = createFakeAcpRuntimeBackend();
    const sent: any[] = [];

    const session = createBasicSessionClientWithOverrides({
      sendAgentMessage: (_provider, body) => {
        sent.push(body);
      },
    });

    const runtime = createAcpRuntime({
      provider: 'pi',
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
    });
    const runtimeEvents = collectRuntimeEvents(runtime);

    await runtime.sendTurnPrompt('session setup');
    runtime.beginTurn();

    await runtime.flushTurn();
    expect(sent.some((m) => m?.type === 'task_complete')).toBe(true);
    expect(runtimeEvents.some((event) => event.kind === 'turn-complete')).toBe(true);
  });

  it('flushes pending permission requests when the turn ends', async () => {
    const backend = createFakeAcpRuntimeBackend();
    const flushReasons: string[] = [];

    const runtime = createAcpRuntime({
      provider: 'pi',
      directory: '/tmp',
      session: createBasicSessionClient(),
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: {
        handleToolCall: async () => ({ decision: 'approved' }),
        abortPendingRequestsAndFlush: async (reason: string) => {
          flushReasons.push(reason);
        },
      },
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
    });

    await runtime.sendTurnPrompt('session setup');
    runtime.beginTurn();

    await runtime.flushTurn();

    expect(flushReasons).toEqual(['ACP runtime turn ended']);
  });

  it('surfaces refused turn outcomes without completing the primary turn', async () => {
    const backend = createFakeAcpRuntimeBackend({
      waitForResponseComplete: async () => ({ kind: 'refused', stopReason: 'refusal' }),
    });
    const sent: any[] = [];

    const session = createBasicSessionClientWithOverrides({
      sendAgentMessage: (_provider, body) => {
        sent.push(body);
      },
    });

    const runtime = createAcpRuntime({
      provider: 'gemini',
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
    });
    const runtimeEvents = collectRuntimeEvents(runtime);

    await runtime.sendTurnPrompt('session setup');
    runtime.beginTurn();
    await runtime.sendPrompt('hello');
    await runtime.flushTurn();

    expect(sent.some((m) => m?.type === 'task_complete')).toBe(false);
    expect(sent.some((m) => m?.type === 'turn_failed')).toBe(true);
    expect(runtimeEvents.some((event) => event.kind === 'turn-failed')).toBe(true);
    expect(runtimeEvents.some((event) => event.kind === 'turn-complete')).toBe(false);
  });

  it('surfaces cancelled turn outcomes without completing the primary turn', async () => {
    const backend = createFakeAcpRuntimeBackend({
      waitForResponseComplete: async () => ({ kind: 'aborted', stopReason: 'cancelled' }),
    });
    const sent: any[] = [];

    const session = createBasicSessionClientWithOverrides({
      sendAgentMessage: (_provider, body) => {
        sent.push(body);
      },
    });

    const runtime = createAcpRuntime({
      provider: 'gemini',
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
    });
    const runtimeEvents = collectRuntimeEvents(runtime);

    await runtime.sendTurnPrompt('session setup');
    runtime.beginTurn();
    await runtime.sendPrompt('hello');
    await runtime.flushTurn();

    expect(sent.some((m) => m?.type === 'task_complete')).toBe(false);
    expect(sent.some((m) => m?.type === 'turn_cancelled')).toBe(true);
    expect(runtimeEvents.some((event) => event.kind === 'turn-cancelled')).toBe(true);
    expect(runtimeEvents.some((event) => event.kind === 'turn-complete')).toBe(false);
  });

  it('treats completed turn outcomes with no runtime activity as failed no-output turns', async () => {
    const backend = createFakeAcpRuntimeBackend({
      waitForResponseComplete: async () => ({ kind: 'completed', stopReason: 'end_turn' }),
    });
    const sent: any[] = [];

    const session = createBasicSessionClientWithOverrides({
      sendAgentMessage: (_provider, body) => {
        sent.push(body);
      },
    });

    const runtime = createAcpRuntime({
      provider: 'gemini',
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
    });
    const runtimeEvents = collectRuntimeEvents(runtime);

    await runtime.sendTurnPrompt('session setup');
    runtime.beginTurn();
    await runtime.sendPrompt('hello');
    await runtime.flushTurn();

    expect(sent.some((m) => m?.type === 'task_complete')).toBe(false);
    expect(sent.some((m) => m?.type === 'turn_failed')).toBe(true);
    expect(runtimeEvents.some((event) => event.kind === 'turn-failed')).toBe(true);
    expect(runtimeEvents.some((event) => event.kind === 'turn-complete')).toBe(false);
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

    await runtime.sendTurnPrompt('session setup');

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
    const flushReasons: string[] = [];

    const runtime = createAcpRuntime({
      provider: 'opencode',
      directory: '/tmp',
      session: createBasicSessionClient(),
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: {
        handleToolCall: async () => ({ decision: 'approved' }),
        abortPendingRequestsAndFlush: async (reason: string) => {
          flushReasons.push(reason);
        },
      },
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
    });

    await runtime.sendTurnPrompt('session setup');

    runtime.beginTurn();
    expect(runtime.isTurnInFlight()).toBe(true);

    await runtime.cancel();
    expect(runtime.isTurnInFlight()).toBe(false);
    expect(flushReasons).toEqual(['ACP runtime cancelled']);
  });
});
