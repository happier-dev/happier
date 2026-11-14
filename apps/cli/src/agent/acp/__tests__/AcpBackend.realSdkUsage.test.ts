import { describe, expect, it } from 'vitest';

import type { AgentMessage } from '../../core';
import { AcpBackend } from '../AcpBackend';
import { writeAcpTestAgentScript } from '../testkit/subprocessHarness';
import { withTempDir } from '@/testkit/fs/tempDir';

describe('ACP prompt usage across the real SDK boundary', () => {
  it.each([
    { label: 'partial native counters', response: { usage: { inputTokens: 7, outputTokens: 3 } }, tokens: { input: 7, output: 3 } },
    { label: 'metadata usage', response: { _meta: { usage: { totalTokens: 10, inputTokens: 7, outputTokens: 3 } } }, tokens: { total: 10, input: 7, output: 3 } },
    { label: 'absent native usage', response: {}, tokens: null },
  ])('preserves $label over completed and subsequent turns', async ({ response, tokens }) => {
    await withTempDir('happier-acp-wire-usage-', async cwd => {
      // The subprocess is the external Agent boundary; SDK parsing, turn handling,
      // and usage normalization all run in the production host.
      const script = writeAcpTestAgentScript({ dir: cwd, fileName: 'usage-agent.mjs', source: `
        import { createInterface } from 'node:readline';
        for await (const line of createInterface({ input: process.stdin })) {
          const request = JSON.parse(line);
          if (request.id === undefined) continue;
          let result = {};
          if (request.method === 'initialize') result = { protocolVersion: 1, agentCapabilities: {} };
          if (request.method === 'session/new') result = { sessionId: 'wire-usage-session' };
          if (request.method === 'session/prompt') result = { stopReason: 'end_turn', ...${JSON.stringify(response)} };
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
        }
      ` });
      const backend = new AcpBackend({ agentName: 'test', cwd, command: process.execPath, args: [script] });
      const messages: AgentMessage[] = [];
      backend.onMessage(message => messages.push(message));
      try {
        const { sessionId } = await backend.startSession();
        for (const prompt of ['first turn', 'subsequent turn']) {
          messages.length = 0;
          await backend.sendPrompt(sessionId, prompt);
          await backend.waitForResponseComplete();
          const usage = messages.filter(message => message.type === 'token-count');
          if (tokens === null) {
            expect(usage).toEqual([]);
          } else {
            expect(usage).toEqual([expect.objectContaining({
              type: 'token-count', source: 'acp-prompt-usage', scope: 'turn_delta', tokens,
            })]);
          }
        }
      } finally {
        await backend.dispose();
      }
    });
  });
});
