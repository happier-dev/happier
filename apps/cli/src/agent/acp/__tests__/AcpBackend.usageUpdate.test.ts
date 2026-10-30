import { describe, it, expect } from 'vitest';

import { AcpBackend } from '../AcpBackend';
import type { AgentMessage } from '../../core';

describe('AcpBackend session usage_update', () => {
  it.each(['embedded', 'direct'])('preserves overlapping camelCase usage details on %s session usage', async (kind) => {
    const backend = new AcpBackend({ agentName: 'test', cwd: process.cwd(), command: 'noop' });
    const emitted: AgentMessage[] = [];
    backend.onMessage((message) => emitted.push(message));
    const usage = { inputTokens: 100, outputTokens: 40, cacheReadTokens: 30, cacheWriteTokens: 10, reasoningTokens: 15 };

    await (backend as unknown as { handleSessionUpdate(notification: unknown): Promise<void> }).handleSessionUpdate({
      update: kind === 'embedded' ? {
        sessionUpdate: 'task_complete',
        id: 'task_1',
        usage,
      } : { sessionUpdate: 'usage_update', ...usage },
    });

    expect(emitted.filter((message) => message.type === 'token-count')).toEqual([expect.objectContaining({
      type: 'token-count',
      source: kind === 'embedded' ? 'acp-session-update-usage' : 'acp-usage-update',
      tokens: { total: 140, input: 100, output: 40, cache_read: 30, cache_creation: 10, thought: 15 },
    })]);
  });

  it('emits token-count telemetry from usage_update notifications', async () => {
    const backend = new AcpBackend({
      agentName: 'test',
      cwd: process.cwd(),
      command: 'noop',
    });

    const emitted: any[] = [];
    backend.onMessage((msg) => emitted.push(msg));

    await (backend as any).handleSessionUpdate({
      update: {
        sessionUpdate: 'usage_update',
        used: 123,
        size: 1000,
      },
    });

    const token = emitted.find((m) => m?.type === 'token-count');
    expect(token).toBeTruthy();
    expect(token.tokens).toEqual({ total: 123, used: 123, size: 1000 });
  });

  it('accepts input/output token fields in usage_update notifications', async () => {
    const backend = new AcpBackend({
      agentName: 'test',
      cwd: process.cwd(),
      command: 'noop',
    });

    const emitted: any[] = [];
    backend.onMessage((msg) => emitted.push(msg));

    await (backend as any).handleSessionUpdate({
      update: {
        sessionUpdate: 'usage_update',
        input_tokens: 10,
        output_tokens: 4,
        cache_read_input_tokens: 3,
        cache_creation_input_tokens: 2,
      },
    });

    const token = emitted.find((m) => m?.type === 'token-count');
    expect(token).toBeTruthy();
    expect(token.tokens).toEqual({
      total: 19,
      input: 10,
      output: 4,
      cache_read: 3,
      cache_creation: 2,
    });
  });

  it('preserves cumulative USD cost fields from usage_update notifications', async () => {
    const backend = new AcpBackend({
      agentName: 'test',
      cwd: process.cwd(),
      command: 'noop',
    });

    const emitted: any[] = [];
    backend.onMessage((msg) => emitted.push(msg));

    await (backend as any).handleSessionUpdate({
      update: {
        sessionUpdate: 'usage_update',
        input_tokens: 10,
        output_tokens: 4,
        cost_usd: 0.125,
      },
    });

    const token = emitted.find((m) => m?.type === 'token-count');
    expect(token).toBeTruthy();
    expect(token.cost).toEqual({ total: 0.125 });
  });

  it('preserves ACP Cost object amount as cumulative USD cost', async () => {
    const backend = new AcpBackend({
      agentName: 'test',
      cwd: process.cwd(),
      command: 'noop',
    });

    const emitted: any[] = [];
    backend.onMessage((msg) => emitted.push(msg));

    await (backend as any).handleSessionUpdate({
      update: {
        sessionUpdate: 'usage_update',
        input_tokens: 10,
        output_tokens: 4,
        cost: { amount: 0.25, currency: 'USD' },
      },
    });

    await (backend as any).handleSessionUpdate({
      update: {
        sessionUpdate: 'usage_update',
        input_tokens: 20,
        output_tokens: 8,
        cost: { amount: 0.5, currency: 'usd' },
      },
    });

    const tokens = emitted.filter((m) => m?.type === 'token-count');
    expect(tokens.map((token) => token.cost)).toEqual([{ total: 0.25 }, { total: 0.5 }]);
  });

  it('handles SessionNotification updates[] arrays (does not drop later updates)', async () => {
    const backend = new AcpBackend({
      agentName: 'test',
      cwd: process.cwd(),
      command: 'noop',
    });

    const emitted: any[] = [];
    backend.onMessage((msg) => emitted.push(msg));

    await (backend as any).handleSessionUpdate({
      updates: [
        {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'hello' },
          messageChunk: { textDelta: 'hello' },
        },
        {
          sessionUpdate: 'usage_update',
          used: 123,
          size: 1000,
        },
      ],
    });

    const token = emitted.find((m) => m?.type === 'token-count');
    expect(token).toBeTruthy();
    expect(token.tokens).toEqual({ total: 123, used: 123, size: 1000 });
  });

  it('emits token-count telemetry when task_complete includes a usage payload', async () => {
    const backend = new AcpBackend({
      agentName: 'test',
      cwd: process.cwd(),
      command: 'noop',
    });

    const emitted: any[] = [];
    backend.onMessage((msg) => emitted.push(msg));

    await (backend as any).handleSessionUpdate({
      update: {
        sessionUpdate: 'task_complete',
        id: 'task_1',
        usage: { input_tokens: 2, output_tokens: 3 },
      },
    });

    const token = emitted.find((m) => m?.type === 'token-count');
    expect(token).toBeTruthy();
    expect(token.tokens).toEqual({ total: 5, input: 2, output: 3 });
  });
});
