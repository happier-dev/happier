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

    backend.emit({
      type: 'token-count',
      key: 'turn-1',
      model: 'model-a',
      tokens: { total: 5, input: 2, output: 3 },
      cost: { total: 1.25 },
    } as any);

    expect(sent.some((b) => b.type === 'token_count')).toBe(true);
    const token = sent.find((b) => b.type === 'token_count') as any;
    expect(token.tokens).toEqual({ total: 5, input: 2, output: 3 });
    expect(token.key).toBe('turn-1');
    expect(token.model).toBe('model-a');
    expect(token.cost).toEqual({ total: 1.25 });
  });

  it('sanitizes tokens and cost payloads before forwarding', async () => {
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

    backend.emit({
      type: 'token-count',
      key: '  turn-1  ',
      model: ' model-a ',
      tokens: { total: 'nope', input: 2, extra: 'x' },
      cost: { total: 'bad', component: 0.1, nested: { leak: 999 }, __proto__: 1 },
    } as any);

    const token = sent.find((b) => b.type === 'token_count') as any;
    expect(token).toBeTruthy();
    expect(token.key).toBe('turn-1');
    expect(token.model).toBe('model-a');
    expect(token.tokens).toEqual({ total: 2, input: 2 });
    expect(token.cost).toEqual({ total: 0.1, component: 0.1 });
    expect(Object.getPrototypeOf(token.cost)).toBeNull();
    expect((token.cost?.nested ?? null)).toBeNull();
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

  it('clamps token-count token maps to a bounded keyset', async () => {
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

    const tokens: Record<string, number> = { input: 1, output: 2 };
    for (let i = 0; i < 100; i++) {
      tokens[`k${i}`] = i;
    }

    backend.emit({
      type: 'token-count',
      tokens,
    } as any);

    const token = sent.find((b) => b.type === 'token_count') as any;
    expect(token).toBeTruthy();
    expect(Object.keys(token.tokens).length).toBeLessThanOrEqual(32);
    expect(token.tokens.total).toBeGreaterThan(0);
    expect(token.tokens.input).toBe(1);
    expect(token.tokens.output).toBe(2);
  });
});
