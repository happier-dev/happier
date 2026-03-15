import { describe, expect, it } from 'vitest';

import { MessageBuffer } from '@/ui/ink/messageBuffer';
import type { AgentMessage } from '@/agent/core/AgentMessage';
import type { ACPMessageData } from '@/api/session/sessionMessageTypes';

import { createAcpRuntime } from '../createAcpRuntime';
import { createApprovedPermissionHandler, createFakeAcpRuntimeBackend } from '../createAcpRuntime.testkit';

describe('createAcpRuntime (status error surfacing)', () => {
  it('surfaces status:error detail as an ACP message so the UI is not silent', async () => {
    const backend = createFakeAcpRuntimeBackend({ sessionId: 'sess_main' });

    const sent: ACPMessageData[] = [];

    const runtime = createAcpRuntime({
      provider: 'pi',
      directory: '/tmp',
      session: {
        keepAlive: () => {},
        sendAgentMessage: (_provider, body) => {
          sent.push(body);
        },
        sendAgentMessageCommitted: async () => {},
        sendUserTextMessageCommitted: async () => {},
        fetchRecentTranscriptTextItemsForAcpImport: async () => [],
        updateMetadata: () => {},
      },
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
    });

    await runtime.startOrLoad({});
    runtime.beginTurn();

    backend.emit({ type: 'status', status: 'error', detail: 'Model not found.' } satisfies AgentMessage);

    expect(sent.some((msg) => msg.type === 'message' && msg.message.includes('Model not found'))).toBe(true);
    expect(sent.some((msg) => msg.type === 'turn_aborted')).toBe(true);
  });
});

