import { describe, expect, it } from 'vitest';

import { AcpBackend } from '../AcpBackend';
import { writeAcpTestAgentScript } from '../testkit/subprocessHarness';
import { withTempDir } from '@/testkit/fs/tempDir';
import { OpenCodeTransport } from '@/backends/opencode/acp/transport';
import { KiloTransport } from '@/backends/kilo/acp/transport';

function writeFakePermissionEchoAgentScript(params: { dir: string }): string {
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
          permissionRequestId = 'req_perm_1';
          send({
            jsonrpc: '2.0',
            id: permissionRequestId,
            method: 'session/request_permission',
            params: {
              sessionId: 'test-session',
              toolCall: {
                toolCallId: 'tool_call_1',
                kind: 'edit',
                rawInput: { path: '../outside.txt' },
              },
              options: [
                { optionId: 'allow-once', kind: 'allow_once', name: 'Allow once' },
                { optionId: 'allow-always', kind: 'allow_always', name: 'Always allow' },
                { optionId: 'reject-once', kind: 'reject_once', name: 'Reject' },
              ],
            },
          });
          continue;
        }

        if (!method && id === permissionRequestId) {
          const optionId = msg && msg.result && msg.result.outcome && msg.result.outcome.optionId ? msg.result.outcome.optionId : 'unknown';
          send({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: 'test-session',
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'permission-option-id=' + String(optionId) },
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
    fileName: 'fake-acp-permission-option-echo-agent.mjs',
    source: src,
  });
}

async function expectPermissionOption(params: { transport: any; expectedOptionId: string }): Promise<void> {
  await withTempDir('happier-acp-perm-option-', async (dir) => {
    const scriptPath = writeFakePermissionEchoAgentScript({ dir });
    let backendForCleanup: AcpBackend | undefined;

    try {
      const emitted: any[] = [];
      const backend = new AcpBackend({
        agentName: 'test',
        cwd: dir,
        command: process.execPath,
        args: [scriptPath],
        permissionHandler: {
          async handleToolCall() {
            return { decision: 'approved' as const };
          },
        },
        transportHandler: params.transport,
      });
      backendForCleanup = backend;
      backend.onMessage((msg) => emitted.push(msg));

      const started = await backend.startSession();
      await backend.sendPrompt(started.sessionId, 'trigger permission');

      const startMs = Date.now();
      while (!emitted.some((msg) => msg.type === 'model-output') && Date.now() - startMs < 5_000) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      const combinedText = emitted
        .filter((msg) => msg.type === 'model-output' && typeof msg.textDelta === 'string')
        .map((msg) => msg.textDelta)
        .join('');
      expect(combinedText).toContain(`permission-option-id=${params.expectedOptionId}`);
    } finally {
      await backendForCleanup?.dispose().catch(() => {});
    }
  });
}

describe('AcpBackend OpenCode-family permission option selection', () => {
  it('prefers allow_always when OpenCodeTransport approves a permission', async () => {
    await expectPermissionOption({
      transport: new OpenCodeTransport(),
      expectedOptionId: 'allow-always',
    });
  });

  it('prefers allow_always when KiloTransport approves a permission', async () => {
    await expectPermissionOption({
      transport: new KiloTransport(),
      expectedOptionId: 'allow-always',
    });
  });
});

