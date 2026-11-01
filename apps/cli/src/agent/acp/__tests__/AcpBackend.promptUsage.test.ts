import { describe, it, expect } from 'vitest';

import { AcpBackend } from '../AcpBackend';
import type { AgentMessage } from '../../core';

describe('AcpBackend sendPrompt usage telemetry', () => {
  it('preserves fx 0.0.14 prompt usage without adding overlapping cache and reasoning counts', async () => {
    const backend = new AcpBackend({ agentName: 'fx', cwd: process.cwd(), command: 'noop' });
    const emitted: AgentMessage[] = [];
    backend.onMessage((message) => emitted.push(message));
    // The ACP peer is the external process boundary; keep sendPrompt and projection real.
    Object.assign(backend, {
      acpSessionId: 'sess_fx',
      connection: {
        peer: {
          prompt: async () => ({
            stopReason: 'end_turn',
            // vercel-labs/fx 1a070af32cdf, src/acp/types.zig PromptResponseUsage.
            usage: { inputTokens: 100, outputTokens: 40, cacheReadTokens: 30, cacheWriteTokens: 10, reasoningTokens: 15 },
          }),
        },
      },
    });

    await backend.sendPrompt('sess_fx', 'hello');

    expect(emitted.filter((message) => message.type === 'token-count')).toEqual([expect.objectContaining({
      type: 'token-count',
      source: 'acp-prompt-usage',
      tokens: { total: 140, input: 100, output: 40, cache_read: 30, cache_creation: 10, thought: 15 },
    })]);
  });

  it.each([10, null])('emits snake_case usage with explicit total %s or its additive fallback', async (explicitTotal) => {
    const backend = new AcpBackend({
      agentName: 'test',
      cwd: process.cwd(),
      command: 'noop',
    });

    const emitted: any[] = [];
    backend.onMessage((msg) => emitted.push(msg));

    (backend as any).acpSessionId = 'sess_1';
    (backend as any).connection = {
      peer: {
        prompt: async () => ({
          stopReason: 'end_turn',
          usage: {
            ...(explicitTotal === null ? {} : { total_tokens: explicitTotal }),
            input_tokens: 7,
            output_tokens: 3,
            cached_read_tokens: 2,
            cached_write_tokens: 1,
            thought_tokens: 4,
          },
        }),
      },
    };

    await backend.sendPrompt('sess_1', 'hello');

    const tokenCount = emitted.find((m) => m?.type === 'token-count');
    expect(tokenCount).toBeTruthy();
    expect(tokenCount.tokens).toEqual({
      total: explicitTotal ?? 17,
      input: 7,
      output: 3,
      cache_read: 2,
      cache_creation: 1,
      thought: 4,
    });
  });

  it('reads the ACP metadata usage envelope through the provider-owned usage projector', async () => {
    const backend = new AcpBackend({
      agentName: 'test',
      cwd: process.cwd(),
      command: 'noop',
      promptUsageAdapter: {
        project({ usage }) {
          const record = usage as Record<string, number>;
          return {
            tokens: {
              total: record.totalTokens,
              input: record.inputTokens,
              output: record.outputTokens,
            },
            cost: { total: 0.25 },
          };
        },
      },
    });

    const emitted: any[] = [];
    backend.onMessage((msg) => emitted.push(msg));

    (backend as any).acpSessionId = 'sess_1';
    (backend as any).connection = {
      peer: {
        prompt: async () => ({
          stopReason: 'end_turn',
          _meta: {
            usage: {
              totalTokens: 10,
              inputTokens: 7,
              outputTokens: 3,
            },
          },
        }),
      },
    };

    await backend.sendPrompt('sess_1', 'hello');

    expect(emitted.find((message) => message?.type === 'token-count')).toMatchObject({
      key: 'acp-prompt-usage',
      tokens: { total: 10, input: 7, output: 3 },
      cost: { total: 0.25 },
      source: 'acp-prompt-usage',
    });
  });

});
