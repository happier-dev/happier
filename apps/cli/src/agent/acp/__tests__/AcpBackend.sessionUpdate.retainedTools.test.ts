import { describe, expect, it } from 'vitest';

import { AcpBackend } from '../AcpBackend';
import type { AgentMessage } from '../../core';
import { createAcpTestTransportHandler, writeAcpTestAgentScript } from '../testkit/subprocessHarness';
import { withTempDir } from '@/testkit/fs/tempDir';
import { waitForCondition } from '@/testkit/async/waitFor';

describe('AcpBackend session/update retained tool results', () => {
  it('accepts late provider output only for an exact retained closed-turn tool id', async () => {
    await withTempDir('happier-acp-retained-tools-', async (dir) => {
      const scriptPath = writeAcpTestAgentScript({
        dir, fileName: 'retained-tools.mjs',
        source: `
          import { createInterface } from 'node:readline';
          const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
          const update = update => send({ jsonrpc: '2.0', method: 'session/update',
            params: { sessionId: 'native-session', update } });
          createInterface({ input: process.stdin }).on('line', line => {
            const request = JSON.parse(line);
            const ok = result => send({ jsonrpc: '2.0', id: request.id, result });
            if (request.method === 'initialize') ok({ protocolVersion: 1, authMethods: [] });
            else if (request.method === 'session/new') ok({ sessionId: 'native-session' });
            else if (request.method === 'session/prompt') {
              update({ sessionUpdate: 'tool_call', toolCallId: 'known', title: 'Known call',
                status: 'pending', kind: 'read' });
              ok({ stopReason: 'end_turn' });
            } else if (request.method === 'fixture/late') {
              for (const item of [
                { sessionUpdate: 'tool_call_update', toolCallId: 'known', status: 'completed',
                  rawOutput: { text: 'late provider output' } },
                { sessionUpdate: 'tool_call_update', toolCallId: 'unknown', status: 'completed',
                  rawOutput: { text: 'must be dropped' } },
                { sessionUpdate: 'session_info_update', title: 'Late batch complete' },
              ]) update(item);
              ok({});
            } else if (request.id !== undefined) ok({});
          });
        `,
      });
      const backend = new AcpBackend({
        agentName: 'test', cwd: dir, command: process.execPath, args: [scriptPath],
        transportHandler: createAcpTestTransportHandler(),
      });
      const emitted: AgentMessage[] = [];
      backend.onMessage(message => emitted.push(message));
      try {
        const { sessionId } = await backend.startSession();
        await backend.sendPrompt(sessionId, 'read');
        await backend.waitForResponseComplete(5_000);
        const callLocalId = emitted.find(message => message.type === 'tool-call')?.localId;
        expect(callLocalId).toBeDefined();
        emitted.length = 0;

        await backend.requestExtension('fixture/late', {});
        await waitForCondition(
          () => emitted.some(message => message.type === 'event' && message.name === 'session_info_update'),
          { timeoutMs: 5_000, label: 'the complete late ACP update batch' },
        );
        expect(emitted.filter(message => message.type === 'tool-result')).toEqual([
          expect.objectContaining({ callId: 'known', result: expect.objectContaining({ text: 'late provider output' }) }),
        ]);
        expect(emitted.find(message => message.type === 'tool-call')).toMatchObject({
          callId: 'known', localId: callLocalId,
        });
        expect(emitted.some(message => (message.type === 'tool-call' || message.type === 'tool-result') && message.callId === 'unknown')).toBe(false);
      } finally {
        await backend.dispose();
      }
    });
  });
});
