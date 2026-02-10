import { describe, expect, it } from 'vitest';

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AcpBackend } from '../AcpBackend';
import type { ToolPattern, TransportHandler } from '@/agent/transport/TransportHandler';

function writeFakeAcpAgentScript(params: { dir: string }): string {
  const scriptPath = join(params.dir, 'fake-acp-agent-stderr-fatal.mjs');
  const src = `
    const decoder = new TextDecoder();
    let buf = '';

    function send(obj) {
      process.stdout.write(JSON.stringify(obj) + '\\n');
    }

    function ok(id, result) {
      send({ jsonrpc: '2.0', id, result });
    }

    let waitingForPermResponse = false;

    function sendPermissionRequest() {
      send({
        jsonrpc: '2.0',
        id: 'perm-1',
        method: 'session/request_permission',
        params: {
          sessionId: 'test-session',
          toolCall: { toolCallId: 'call-1', kind: 'execute' },
          options: [
            { optionId: 'proceed_once', kind: 'allow_once', name: 'Allow' },
            { optionId: 'cancel', kind: 'reject_once', name: 'Reject' },
          ],
        },
      });
      waitingForPermResponse = true;
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

        // Handle client response to permission request
        if (waitingForPermResponse && req.id === 'perm-1') {
          waitingForPermResponse = false;
          continue;
        }

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
          // Emit stderr *after* prompt is accepted so the client is already waiting for a response.
          process.stderr.write('FATAL: simulated transport failure\\n');
          setTimeout(sendPermissionRequest, 10);
          continue;
        }

        ok(id, {});
      }
    });
  `;

  writeFileSync(scriptPath, src, 'utf8');
  return scriptPath;
}

describe('AcpBackend response completion error preservation', () => {
  it('still throws after idle is emitted if a fatal stderr error was recorded', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'happier-acp-stderr-fatal-'));
    const scriptPath = writeFakeAcpAgentScript({ dir });
    let backendForCleanup: AcpBackend | undefined;

    try {
      const backend = new AcpBackend({
        agentName: 'test',
        cwd: dir,
        command: process.execPath,
        args: [scriptPath],
        transportHandler: {
          agentName: 'test',
          // Some CI machines can be slow to spawn + initialize the fake ACP agent; keep this forgiving.
          getInitTimeout: () => 5_000,
          getToolPatterns: () => [] as ToolPattern[],
          getIdleTimeout: () => 1,
          handleStderr: () => ({
            message: { type: 'status', status: 'error', detail: 'simulated transport error' },
          }),
        } satisfies TransportHandler,
        permissionHandler: {
          async handleToolCall() {
            return { decision: 'denied' as const };
          },
        },
      });
      backendForCleanup = backend;

      let sawStderrErrorStatus = false;
      const stderrErrorStatusSeen = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Timed out waiting for error status')), 5_000);
        backend.onMessage((msg) => {
          if (msg.type === 'status' && msg.status === 'error' && msg.detail === 'simulated transport error') {
            sawStderrErrorStatus = true;
            clearTimeout(timeout);
            resolve();
          }
        });
      });

      const idleAfterErrorSeen = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Timed out waiting for idle status after error')), 5_000);
        backend.onMessage((msg) => {
          if (msg.type === 'status' && msg.status === 'idle' && sawStderrErrorStatus) {
            clearTimeout(timeout);
            resolve();
          }
        });
      });

      const started = await backend.startSession();
      await backend.sendPrompt(started.sessionId, 'hi');
      await stderrErrorStatusSeen;
      await idleAfterErrorSeen;

      await expect(backend.waitForResponseComplete(1_000)).rejects.toThrow('simulated transport error');
    } finally {
      await backendForCleanup?.dispose().catch(() => {});
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
