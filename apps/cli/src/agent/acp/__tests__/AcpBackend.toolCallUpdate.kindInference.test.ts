import { describe, expect, it } from 'vitest';

import { AcpBackend } from '../AcpBackend';
import { createAcpTestTransportHandler, writeAcpTestAgentScript } from '../testkit/subprocessHarness';
import { withTempDir } from '@/testkit/fs/tempDir';

function writeFakeAcpAgentScript(params: { dir: string }): string {
  const src = `
    const decoder = new TextDecoder();
    let buf = '';

    function send(obj) {
      process.stdout.write(JSON.stringify(obj) + '\\n');
    }

    function ok(id, result) {
      send({ jsonrpc: '2.0', id, result });
    }

    function sendToolCallUpdateCompletedWithOutputInRawInput() {
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'test-session',
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'call_deadbeef',
            status: 'completed',
            // Mimic providers that omit kind and embed the output payload in rawInput.
            output: '',
            rawInput: [
              {
                type: 'content',
                content: {
                  type: 'text',
                  text: 'Command: echo hi\\nDirectory: (root)\\nOutput: (empty)\\nError: (none)\\nExit Code: 0',
                },
              },
            ],
          },
        },
      });

      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'test-session',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'done' },
          },
        },
      });
    }

    process.stdin.on('data', (chunk) => {
      buf += decoder.decode(chunk, { stream: true });
      const lines = buf.split('\\n');
      buf = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let req;
        try { req = JSON.parse(trimmed); } catch { continue; }
        if (!req || typeof req !== 'object') continue;

        const id = req.id;
        const method = req.method;
        if (id === undefined || id === null || typeof method !== 'string') continue;

        if (method === 'initialize') {
          ok(id, { protocolVersion: 1, authMethods: [] });
          continue;
        }

        if (method === 'session/new') {
          ok(id, { sessionId: 'test-session' });
          continue;
        }

        if (method === 'session/prompt') {
          ok(id, {});
          setTimeout(sendToolCallUpdateCompletedWithOutputInRawInput, 10);
          continue;
        }

        ok(id, {});
      }
    });
  `;

  return writeAcpTestAgentScript({
    dir: params.dir,
    fileName: 'fake-acp-agent.mjs',
    source: src,
  });
}

describe('AcpBackend tool_call_update kind inference', () => {
  it('infers execute tool kind for command-like output embedded in rawInput when kind is missing', async () => {
    await withTempDir('happier-acp-kind-inference-', async (dir) => {
      const scriptPath = writeFakeAcpAgentScript({ dir });
      let backendForCleanup: AcpBackend | undefined;

      try {
        const backend = new AcpBackend({
          agentName: 'test',
          cwd: dir,
          command: process.execPath,
          args: [scriptPath],
          transportHandler: createAcpTestTransportHandler({
            initTimeoutMs: 1_000,
            idleTimeoutMs: 1,
          }),
        });
        backendForCleanup = backend;

        const toolResults: Array<{ toolName: string; result: unknown }> = [];
        backend.onMessage((msg) => {
          if (msg.type !== 'tool-result') return;
          toolResults.push({ toolName: msg.toolName, result: msg.result });
        });

        const started = await backend.startSession();
        await backend.sendPrompt(started.sessionId, 'hi');
        await backend.waitForResponseComplete(5_000);

        expect(toolResults.length).toBeGreaterThan(0);
        const last = toolResults[toolResults.length - 1]!;

        // Without inference this would be 'unknown'.
        expect(last.toolName).toBe('execute');

        // Without output extraction fallback this would be ''.
        expect(last.result).not.toBe('');
        expect(Array.isArray((last.result as any)?.output)).toBe(true);
      } finally {
        await backendForCleanup?.dispose().catch(() => {});
      }
    });
  }, 15_000);
});
