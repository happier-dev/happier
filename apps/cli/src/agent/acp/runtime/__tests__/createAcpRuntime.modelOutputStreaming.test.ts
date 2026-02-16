import { describe, expect, it } from 'vitest';

import { MessageBuffer } from '@/ui/ink/messageBuffer';
import type { ACPMessageData } from '@/api/session/sessionMessageTypes';
import type { AgentMessage } from '@/agent/core/AgentMessage';

import { createAcpRuntime } from '../createAcpRuntime';
import { createFakeAcpRuntimeBackend, createApprovedPermissionHandler } from '../createAcpRuntime.testkit';

describe('createAcpRuntime (model-output delta streaming)', () => {
  it('forwards model-output text deltas as ACP message chunks with a stable happierStreamKey per turn', async () => {
    const backend = createFakeAcpRuntimeBackend({ sessionId: 'sess_main' });
    const sent: Array<{ body: ACPMessageData; meta?: Record<string, unknown> }> = [];

    const runtime = createAcpRuntime({
      provider: 'claude',
      directory: '/tmp',
      session: {
        keepAlive: () => {},
        sendAgentMessage: (_provider, body, opts) => {
          sent.push({ body, meta: opts?.meta });
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

    backend.emit({ type: 'model-output', textDelta: 'Hello' } satisfies AgentMessage);
    backend.emit({ type: 'model-output', textDelta: ' world' } satisfies AgentMessage);

    const chunkMessages = sent.filter((m) => m.body.type === 'message');
    expect(chunkMessages.length).toBeGreaterThanOrEqual(2);
    expect(chunkMessages[0]?.body.type).toBe('message');
    expect((chunkMessages[0]?.body as any).message).toBe('Hello');
    expect((chunkMessages[1]?.body as any).message).toBe(' world');

    const k0 = (chunkMessages[0]?.meta as any)?.happierStreamKey;
    const k1 = (chunkMessages[1]?.meta as any)?.happierStreamKey;
    expect(typeof k0).toBe('string');
    expect(k0).toBe(k1);

    runtime.flushTurn();

    runtime.beginTurn();
    backend.emit({ type: 'model-output', textDelta: 'Second' } satisfies AgentMessage);
    const next = sent.filter((m) => m.body.type === 'message').slice(-1)[0];
    expect((next?.body as any)?.message).toBe('Second');
    const k2 = (next?.meta as any)?.happierStreamKey;
    expect(typeof k2).toBe('string');
    expect(k2).not.toBe(k0);
  });
});
