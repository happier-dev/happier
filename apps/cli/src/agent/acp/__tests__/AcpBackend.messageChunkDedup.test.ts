import { describe, expect, it } from 'vitest';

import { AcpBackend } from '../AcpBackend';

describe('AcpBackend message chunk deduplication', () => {
  it('emits a single model-output when a notification contains both agent_message_chunk and legacy messageChunk forms for the same chunk', async () => {
    const backend = new AcpBackend({
      agentName: 'test',
      cwd: process.cwd(),
      command: 'noop',
    });

    try {
      const emitted: any[] = [];
      backend.onMessage((msg) => emitted.push(msg));

      (backend as any).handleSessionUpdate({
        updates: [
          {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'PROFILE' },
          },
          {
            messageChunk: { textDelta: 'PROFILE' },
          },
        ],
      });

      const modelOutputs = emitted.filter((msg) => msg?.type === 'model-output');
      expect(modelOutputs).toEqual([{ type: 'model-output', textDelta: 'PROFILE' }]);
    } finally {
      await backend.dispose().catch(() => {});
    }
  });

  it('keeps distinct legacy messageChunk payloads that are not mirrored by a structured chunk', async () => {
    const backend = new AcpBackend({
      agentName: 'test',
      cwd: process.cwd(),
      command: 'noop',
    });

    try {
      const emitted: any[] = [];
      backend.onMessage((msg) => emitted.push(msg));

      (backend as any).handleSessionUpdate({
        updates: [
          {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'PROFILE' },
          },
          {
            messageChunk: { textDelta: '_STACK' },
          },
        ],
      });

      const modelOutputs = emitted.filter((msg) => msg?.type === 'model-output');
      expect(modelOutputs).toEqual([
        { type: 'model-output', textDelta: 'PROFILE' },
        { type: 'model-output', textDelta: '_STACK' },
      ]);
    } finally {
      await backend.dispose().catch(() => {});
    }
  });
});
