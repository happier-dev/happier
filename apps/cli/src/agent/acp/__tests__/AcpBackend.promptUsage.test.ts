import { describe, it, expect } from 'vitest';

import { AcpBackend } from '../AcpBackend';

describe('AcpBackend sendPrompt usage telemetry', () => {
  it('emits a token-count message when ACP prompt response includes usage', async () => {
    const backend = new AcpBackend({
      agentName: 'test',
      cwd: process.cwd(),
      command: 'noop',
    });

    const emitted: any[] = [];
    backend.onMessage((msg) => emitted.push(msg));

    (backend as any).acpSessionId = 'sess_1';
    (backend as any).connection = {
      prompt: async () => ({
        stopReason: 'end_turn',
        usage: {
          total_tokens: 10,
          input_tokens: 7,
          output_tokens: 3,
          cached_read_tokens: 2,
          cached_write_tokens: 1,
          thought_tokens: 4,
        },
      }),
    };

    await backend.sendPrompt('sess_1', 'hello');

    const tokenCount = emitted.find((m) => m?.type === 'token-count');
    expect(tokenCount).toBeTruthy();
    expect(tokenCount.tokens).toEqual({
      total: 10,
      input: 7,
      output: 3,
      cache_read: 2,
      cache_creation: 1,
      thought: 4,
    });
  });
});

