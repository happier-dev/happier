import { describe, expect, it } from 'vitest';

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AcpBackend } from '../AcpBackend';
import type { ToolPattern, TransportHandler } from '@/agent/transport/TransportHandler';

function writeFakePermissionAgentScript(params: { dir: string }): string {
  const scriptPath = join(params.dir, 'fake-acp-permission-agent.mjs');
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
                title: 'Shell: echo PERM_DENY_SOCKET_LIFECYCLE',
                rawInput: { command: ['echo', 'PERM_DENY_SOCKET_LIFECYCLE'] },
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
              },
              options: [
                { optionId: 'allow_once', kind: 'allow_once', name: 'Yes' },
                { optionId: 'deny', kind: 'reject_once', name: 'Stop' },
              ],
            },
          });
          continue;
        }

        // Response to our session/request_permission request.
        if (!method && id === permissionRequestId) {
          // Intentionally emit no terminal tool updates. Backend must clear active tool call
          // on denied permission so waitForResponseComplete can resolve.
          continue;
        }

        if (id !== undefined && id !== null && typeof method === 'string') {
          ok(id, {});
        }
      }
    });
  `;

  writeFileSync(scriptPath, src, 'utf8');
  return scriptPath;
}

describe('AcpBackend permission deny cleanup', () => {
  it('resolves waitForResponseComplete after denied permission without waiting for tool timeout', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'happier-acp-perm-deny-'));
    const scriptPath = writeFakePermissionAgentScript({ dir });
    let backendForCleanup: AcpBackend | undefined;

    try {
      const backend = new AcpBackend({
        agentName: 'test',
        cwd: dir,
        command: process.execPath,
        args: [scriptPath],
        permissionHandler: {
          handleToolCall: async () => ({ decision: 'denied' }),
        },
        transportHandler: {
          agentName: 'test',
          getInitTimeout: () => 1_000,
          getToolPatterns: () => [] as ToolPattern[],
          getIdleTimeout: () => 1,
        } satisfies TransportHandler,
      });
      backendForCleanup = backend;

      const started = await backend.startSession();
      await backend.sendPrompt(started.sessionId, 'please run bash with permission');

      await expect(backend.waitForResponseComplete(250)).resolves.toBeUndefined();
    } finally {
      await backendForCleanup?.dispose().catch(() => {});
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
