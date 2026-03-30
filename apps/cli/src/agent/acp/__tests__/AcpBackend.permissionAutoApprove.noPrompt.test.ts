import { describe, expect, it } from 'vitest';

import { AcpBackend } from '../AcpBackend';
import { createAcpTestTransportHandler, writeAcpTestAgentScript } from '../testkit/subprocessHarness';
import { withTempDir } from '@/testkit/fs/tempDir';

function writeFakePermissionAgentScript(params: { dir: string }): string {
  const commandRequestText = `Requesting approval to perform: Run command \`node apps/cli/src/index.ts tools call --source happier --tool change_title --args-json '{"title":"Get QA Marker"}' --json\``;
  const src = `
    const decoder = new TextDecoder();
    let buf = '';
    let permissionRequestId = null;

    function send(obj) {
      process.stdout.write(JSON.stringify(obj) + '\\n');
    }

    function ok(id, result) {
      send({ jsonrpc: '2.0', id, result });
    }

    process.stdin.on('data', (chunk) => {
      buf += decoder.decode(chunk, { stream: true });
      const lines = buf.split('\\n');
      buf = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let msg;
        try { msg = JSON.parse(trimmed); } catch { continue; }
        if (!msg || typeof msg !== 'object') continue;

        const id = msg.id;
        const method = msg.method;

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
          send({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: 'test-session',
              update: {
                sessionUpdate: 'tool_call',
                toolCallId: 'tool_call_1',
                status: 'pending',
                kind: 'execute',
                title: 'Shell: TSX_TSCONFIG_PATH=...',
                rawInput: { title: 'Shell', description: 'Shell', _acp: { title: 'Shell' } },
              },
            },
          });
          permissionRequestId = 'req_perm_1';
          send({
            jsonrpc: '2.0',
            id: permissionRequestId,
            method: 'session/request_permission',
            params: {
              sessionId: 'test-session',
              toolCall: {
                toolCallId: 'tool_call_1',
                kind: 'execute',
                rawInput: { title: 'Shell', description: 'Shell', _acp: { title: 'Shell' } },
                content: [
                  {
                    type: 'content',
                    content: {
                    type: 'text',
                      text: ${JSON.stringify(commandRequestText)},
                    },
                  },
                ],
              },
              options: [
                { optionId: 'allow_once', kind: 'allow_once', name: 'Approve once' },
                { optionId: 'deny', kind: 'reject_once', name: 'Reject' },
              ],
            },
          });
          continue;
        }

        if (!method && id === permissionRequestId) {
          send({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: 'test-session',
              update: {
                sessionUpdate: 'tool_call_update',
                toolCallId: 'tool_call_1',
                status: 'completed',
                output: {
                  output: [
                    {
                      type: 'content',
                      content: {
                        type: 'text',
                        text: '{"v":1,"ok":true,"kind":"tools_call","data":{"source":"happier","tool":"change_title","isError":false,"output":{"success":true,"title":"Get QA Marker"}}}',
                      },
                    },
                  ],
                },
              },
            },
          });
          continue;
        }

        if (id !== undefined && id !== null && typeof method === 'string') {
          ok(id, {});
        }
      }
    });
  `;

  return writeAcpTestAgentScript({
    dir: params.dir,
    fileName: 'fake-acp-permission-auto-approve-agent.mjs',
    source: src,
  });
}

describe('AcpBackend auto-approved permission requests', () => {
  it('does not emit a permission-request event when the handler can auto-approve immediately', async () => {
    await withTempDir('happier-acp-perm-auto-approve-', async (dir) => {
      const scriptPath = writeFakePermissionAgentScript({ dir });
      let backendForCleanup: AcpBackend | undefined;

      try {
        const emitted: any[] = [];
        const backend = new AcpBackend({
          agentName: 'test',
          cwd: dir,
          command: process.execPath,
          args: [scriptPath],
          permissionHandler: {
            getImmediateDecision() {
              return { decision: 'approved' as const };
            },
            async handleToolCall() {
              return { decision: 'approved' as const };
            },
          },
          transportHandler: createAcpTestTransportHandler({
            initTimeoutMs: 1_000,
            idleTimeoutMs: 50,
          }),
        });
        backendForCleanup = backend;
        backend.onMessage((msg) => emitted.push(msg));

        const started = await backend.startSession();
        await backend.sendPrompt(started.sessionId, 'rename the session');
        const startMs = Date.now();
        while (!emitted.some((msg) => msg.type === 'tool-result') && Date.now() - startMs < 5_000) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }

        expect(emitted.some((msg) => msg.type === 'permission-request')).toBe(false);
        expect(
          emitted.some(
            (msg) =>
              msg.type === 'tool-result'
              && typeof msg.result === 'object'
              && msg.result !== null,
          ),
        ).toBe(true);
      } finally {
        await backendForCleanup?.dispose().catch(() => {});
      }
    });
  });
});
