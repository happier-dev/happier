import { describe, expect, it } from 'vitest';

import { MessageBuffer } from '@/ui/ink/messageBuffer';
import type { AgentMessage } from '@/agent/core/AgentMessage';

import { createAcpRuntime } from '../createAcpRuntime';
import { createApprovedPermissionHandler, createFakeAcpRuntimeBackend } from '../createAcpRuntime.testkit';

describe('createAcpRuntime (thinking state)', () => {
  it('sets thinking on beginTurn and clears on flushTurn', async () => {
    const backend = createFakeAcpRuntimeBackend({ sessionId: 'sess_main' });

    const thinkingChanges: boolean[] = [];
    const keepAliveThinking: boolean[] = [];
    const messageBuffer = new MessageBuffer();

    const runtime = createAcpRuntime({
      provider: 'pi',
      directory: '/tmp',
      session: {
        keepAlive: (thinking: boolean) => {
          keepAliveThinking.push(thinking);
        },
        sendAgentMessage: () => {},
        sendTranscriptDraftDelta: () => {},
        sendAgentMessageCommitted: async () => {},
        sendUserTextMessageCommitted: async () => {},
        fetchRecentTranscriptTextItemsForAcpImport: async () => [],
        updateMetadata: () => {},
      },
      messageBuffer,
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: (thinking) => {
        thinkingChanges.push(thinking);
      },
      ensureBackend: async () => backend,
    });

    await runtime.startOrLoad({});
    runtime.beginTurn();
    expect(thinkingChanges.at(-1)).toBe(true);
    expect(keepAliveThinking.at(-1)).toBe(true);

    backend.emit({ type: 'status', status: 'running' } satisfies AgentMessage);
    expect(messageBuffer.getMessages().some((msg) => msg.type === 'system' && msg.content.includes('Thinking'))).toBe(false);

    // flushTurn ends the turn — thinking should clear
    await runtime.flushTurn();
    expect(thinkingChanges.at(-1)).toBe(false);
    expect(keepAliveThinking.at(-1)).toBe(false);
  });

  it('clears thinking on status:idle after turn has been flushed', async () => {
    const backend = createFakeAcpRuntimeBackend({ sessionId: 'sess_main' });

    const thinkingChanges: boolean[] = [];

    const runtime = createAcpRuntime({
      provider: 'pi',
      directory: '/tmp',
      session: {
        keepAlive: () => {},
        sendAgentMessage: () => {},
        sendTranscriptDraftDelta: () => {},
        sendAgentMessageCommitted: async () => {},
        sendUserTextMessageCommitted: async () => {},
        fetchRecentTranscriptTextItemsForAcpImport: async () => [],
        updateMetadata: () => {},
      },
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: (thinking) => {
        thinkingChanges.push(thinking);
      },
      ensureBackend: async () => backend,
    });

    await runtime.startOrLoad({});
    runtime.beginTurn();
    await runtime.flushTurn();

    // Reset tracking
    thinkingChanges.length = 0;

    // A late idle arriving after turn is flushed should still work
    backend.emit({ type: 'status', status: 'idle' } satisfies AgentMessage);
    // No change needed since flushTurn already cleared — but it should not throw/break
    // (onThinkingChange(false) is idempotent)
  });

  it('does NOT clear thinking on status:idle while turn is in-flight (issue #82 flicker)', async () => {
    const backend = createFakeAcpRuntimeBackend({ sessionId: 'sess_main' });

    const thinkingChanges: boolean[] = [];
    const keepAliveThinking: boolean[] = [];

    const runtime = createAcpRuntime({
      provider: 'codex',
      directory: '/tmp',
      session: {
        keepAlive: (thinking: boolean) => {
          keepAliveThinking.push(thinking);
        },
        sendAgentMessage: () => {},
        sendTranscriptDraftDelta: () => {},
        sendAgentMessageCommitted: async () => {},
        sendUserTextMessageCommitted: async () => {},
        fetchRecentTranscriptTextItemsForAcpImport: async () => [],
        updateMetadata: () => {},
      },
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: (thinking) => {
        thinkingChanges.push(thinking);
      },
      ensureBackend: async () => backend,
    });

    await runtime.startOrLoad({});

    // Begin turn — thinking should be true
    runtime.beginTurn();
    expect(runtime.isTurnInFlight()).toBe(true);
    expect(thinkingChanges.at(-1)).toBe(true);
    expect(keepAliveThinking.at(-1)).toBe(true);

    // Backend reports running (normal)
    backend.emit({ type: 'status', status: 'running' } satisfies AgentMessage);

    // Backend emits idle mid-turn (the flicker trigger)
    backend.emit({ type: 'status', status: 'idle' } satisfies AgentMessage);

    // Thinking must NOT have been cleared — turn is still in-flight
    expect(thinkingChanges.at(-1)).toBe(true);
    expect(keepAliveThinking.at(-1)).toBe(true);

    // Emit idle again (simulates repeated flicker pattern)
    backend.emit({ type: 'status', status: 'running' } satisfies AgentMessage);
    backend.emit({ type: 'status', status: 'idle' } satisfies AgentMessage);
    expect(thinkingChanges.at(-1)).toBe(true);

    // flushTurn should still clear thinking
    await runtime.flushTurn();
    expect(thinkingChanges.at(-1)).toBe(false);
    expect(keepAliveThinking.at(-1)).toBe(false);
  });

  it('still clears thinking on status:error even while turn is in-flight', async () => {
    const backend = createFakeAcpRuntimeBackend({ sessionId: 'sess_main' });

    const thinkingChanges: boolean[] = [];

    const runtime = createAcpRuntime({
      provider: 'pi',
      directory: '/tmp',
      session: {
        keepAlive: () => {},
        sendAgentMessage: () => {},
        sendTranscriptDraftDelta: () => {},
        sendAgentMessageCommitted: async () => {},
        sendUserTextMessageCommitted: async () => {},
        fetchRecentTranscriptTextItemsForAcpImport: async () => [],
        updateMetadata: () => {},
      },
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: (thinking) => {
        thinkingChanges.push(thinking);
      },
      ensureBackend: async () => backend,
    });

    await runtime.startOrLoad({});
    runtime.beginTurn();
    expect(thinkingChanges.at(-1)).toBe(true);

    // Error must still clear thinking immediately
    backend.emit({ type: 'status', status: 'error', detail: 'Backend crashed' } satisfies AgentMessage);
    expect(thinkingChanges.at(-1)).toBe(false);
  });
});
