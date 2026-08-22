import { describe, expect, it, vi } from 'vitest';
import {
  AgentSessionRuntimeEventV1Schema,
  type AgentSessionRuntimeEventV1,
} from '@happier-dev/protocol';

import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { createFakeAcpRuntimeBackend } from '@/testkit/backends/acpRuntimeBackend';
import { createApprovedPermissionHandler } from '@/testkit/backends/permissionHandler';
import { createBasicSessionClientWithOverrides } from '@/testkit/backends/sessionFixtures';
import { createAcpRuntime } from '../createAcpRuntime';

function collectRuntimeEvents(runtime: Readonly<{
  subscribeRuntimeEvents: (handler: (message: unknown) => void) => () => void;
}>): AgentSessionRuntimeEventV1[] {
  const events: AgentSessionRuntimeEventV1[] = [];
  runtime.subscribeRuntimeEvents((message) => {
    events.push(AgentSessionRuntimeEventV1Schema.parse(message));
  });
  return events;
}

describe('createAcpRuntime hosted transcript events', () => {
  it('publishes stable ACP turn, tool, hook, and compaction facts without direct transcript sends', async () => {
    const backend = createFakeAcpRuntimeBackend();
    const session = createBasicSessionClientWithOverrides();
    const runtime = createAcpRuntime({
      provider: 'opencode',
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => undefined,
      ensureBackend: async () => backend,
      hooks: {
        onBeforeFlushTurn: ({ sendToolCall, sendToolResult }) => {
          const callId = sendToolCall({ toolName: 'Diff', input: { files: [] }, callId: 'hook-call-1' });
          sendToolResult({ callId, output: { status: 'completed' } });
        },
      },
    });
    const events = collectRuntimeEvents(runtime);

    await runtime.sendTurnPrompt('session setup');
    runtime.beginTurn();
    backend.emit({ type: 'status', status: 'running' });
    backend.emit({ type: 'tool-call', toolName: 'Edit', args: { file_path: 'a.txt' }, callId: 'tool-1' });
    backend.emit({ type: 'tool-result', toolName: 'Edit', callId: 'tool-1', result: { ok: true } });
    backend.emit({
      type: 'event',
      name: 'context_compaction',
      payload: {
        type: 'context-compaction',
        phase: 'completed',
        lifecycleId: 'opencode:context-compaction',
        provider: 'opencode',
        source: 'agent-event',
      },
    });
    await runtime.flushTurn();
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'turn-start', startedBy: 'provider' }),
      expect.objectContaining({
        kind: 'tool-call',
        toolCallId: 'tool-1',
        toolName: 'Edit',
        input: { file_path: 'a.txt' },
      }),
      expect.objectContaining({
        kind: 'tool-result',
        toolCallId: 'tool-1',
        output: { ok: true },
      }),
      expect.objectContaining({
        kind: 'tool-call',
        toolCallId: 'hook-call-1',
        toolName: 'Diff',
        input: { files: [] },
      }),
      expect.objectContaining({
        kind: 'tool-result',
        toolCallId: 'hook-call-1',
        output: { status: 'completed' },
      }),
      expect.objectContaining({
        kind: 'context-compaction',
        compactionId: 'opencode:context-compaction',
        phase: 'completed',
      }),
      expect.objectContaining({ kind: 'turn-complete' }),
    ]));
    expect(events.some((event) => (
      event.kind === 'transcript-message-committed' && event.role === 'user'
    ))).toBe(false);
  });

  it('publishes failed and cancelled ACP lifecycle markers without direct transcript sends', async () => {
    const failedBackend = createFakeAcpRuntimeBackend();
    const failedRuntime = createAcpRuntime({
      provider: 'pi',
      directory: '/tmp',
      session: createBasicSessionClientWithOverrides(),
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => undefined,
      ensureBackend: async () => failedBackend,
    });
    const failedEvents = collectRuntimeEvents(failedRuntime);

    await failedRuntime.sendTurnPrompt('session setup');
    failedRuntime.beginTurn();
    failedBackend.emit({ type: 'status', status: 'error', detail: 'provider failed' });

    await vi.waitFor(() => {
      expect(failedEvents.some((event) => event.kind === 'turn-failed')).toBe(true);
    });

    const cancelledBackend = createFakeAcpRuntimeBackend();
    const cancelledRuntime = createAcpRuntime({
      provider: 'pi',
      directory: '/tmp',
      session: createBasicSessionClientWithOverrides(),
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => undefined,
      ensureBackend: async () => cancelledBackend,
    });
    const cancelledEvents = collectRuntimeEvents(cancelledRuntime);

    await cancelledRuntime.sendTurnPrompt('session setup');
    cancelledRuntime.beginTurn();
    await cancelledRuntime.cancelTurn();
    expect(cancelledEvents.some((event) => event.kind === 'turn-cancelled')).toBe(true);
    expect(cancelledEvents.some((event) => (
      event.kind === 'transcript-message-committed' && event.role === 'user'
    ))).toBe(false);
  });
});
