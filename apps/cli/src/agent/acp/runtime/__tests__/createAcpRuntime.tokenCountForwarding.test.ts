import { describe, expect, it } from 'vitest';

import type { ACPMessageData } from '@/api/session/sessionMessageTypes';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { createAcpRuntime } from '../createAcpRuntime';
import { createApprovedPermissionHandler, createFakeAcpRuntimeBackend } from '../createAcpRuntime.testkit';

describe('createAcpRuntime (token-count forwarding)', () => {
  it('forwards token-count agent messages as token_count session messages', async () => {
    const backend = createFakeAcpRuntimeBackend();
    const sent: ACPMessageData[] = [];
    const session = {
      keepAlive: () => {},
      sendAgentMessage: (_provider: any, body: any) => {
        sent.push(body);
      },
      sendAgentMessageCommitted: async () => {},
      sendUserTextMessageCommitted: async () => {},
      fetchRecentTranscriptTextItemsForAcpImport: async () => [],
      updateMetadata: () => {},
    };

    const runtime = createAcpRuntime({
      provider: 'opencode',
      directory: '/tmp',
      session: session as any,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
    });

    await runtime.startOrLoad({ resumeId: null });

    backend.emit({ type: 'token-count', tokens: { total: 5, input: 2, output: 3 } } as any);

    expect(sent.some((b) => b.type === 'token_count')).toBe(true);
    const token = sent.find((b) => b.type === 'token_count') as any;
    expect(token.tokens).toEqual({ total: 5, input: 2, output: 3 });
  });

  it('does not forward token-count messages when tokens are missing', async () => {
    const backend = createFakeAcpRuntimeBackend();
    const sent: ACPMessageData[] = [];
    const session = {
      keepAlive: () => {},
      sendAgentMessage: (_provider: any, body: any) => {
        sent.push(body);
      },
      sendAgentMessageCommitted: async () => {},
      sendUserTextMessageCommitted: async () => {},
      fetchRecentTranscriptTextItemsForAcpImport: async () => [],
      updateMetadata: () => {},
    };

    const runtime = createAcpRuntime({
      provider: 'opencode',
      directory: '/tmp',
      session: session as any,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
    });

    await runtime.startOrLoad({ resumeId: null });

    backend.emit({ type: 'token-count', foo: 'bar' } as any);

    expect(sent.some((b) => b.type === 'token_count')).toBe(false);
  });
});
