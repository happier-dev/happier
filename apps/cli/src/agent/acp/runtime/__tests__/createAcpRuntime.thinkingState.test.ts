import { describe, expect, it } from 'vitest';

import { MessageBuffer } from '@/ui/ink/messageBuffer';
import type { AgentMessage } from '@/agent/core/AgentMessage';

import { createAcpRuntime } from '../createAcpRuntime';
import { createApprovedPermissionHandler, createFakeAcpRuntimeBackend } from '../createAcpRuntime.testkit';

describe('createAcpRuntime (thinking state)', () => {
  it('clears thinking when backend reports status idle', async () => {
    const backend = createFakeAcpRuntimeBackend({ sessionId: 'sess_main' });

    const thinkingChanges: boolean[] = [];
    const keepAliveThinking: boolean[] = [];

    const runtime = createAcpRuntime({
      provider: 'pi',
      directory: '/tmp',
      session: {
        keepAlive: (thinking: boolean) => {
          keepAliveThinking.push(thinking);
        },
        sendAgentMessage: () => {},
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

    backend.emit({ type: 'status', status: 'running' } satisfies AgentMessage);
    expect(thinkingChanges.at(-1)).toBe(true);
    expect(keepAliveThinking.at(-1)).toBe(true);

    backend.emit({ type: 'status', status: 'idle' } satisfies AgentMessage);
    expect(thinkingChanges.at(-1)).toBe(false);
    expect(keepAliveThinking.at(-1)).toBe(false);
  });
});

