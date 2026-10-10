import { writeFileSync } from 'node:fs';
import { readFile as readFileAsync } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { AcpBackend } from '../AcpBackend';
import { createAcpTestTransportHandler, writeAcpTestAgentScript } from '../testkit/subprocessHarness';
import { withTempDir } from '@/testkit/fs/tempDir';

function writeFakeAcpAgentScript(params: { dir: string }): string {
  const src = `
    import { existsSync, writeFileSync } from 'node:fs';
    import { join } from 'node:path';
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
          writeFileSync(join(${JSON.stringify(params.dir)}, 'withdrawn-permission.json'), JSON.stringify(req.result));
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
          const releasePermission = setInterval(() => {
            if (!existsSync(join(${JSON.stringify(params.dir)}, 'fatal-observed'))) return;
            clearInterval(releasePermission);
            sendPermissionRequest();
          }, 10);
          continue;
        }

        ok(id, {});
      }
    });
  `;

  return writeAcpTestAgentScript({
    dir: params.dir,
    fileName: 'fake-acp-agent-stderr-fatal.mjs',
    source: src,
  });
}

function writeFakeAcpAgentScriptPermissionFirst(params: { dir: string }): string {
  const src = `
    const decoder = new TextDecoder();
    let buf = '';
    let waitingForPermResponse = false;

    function send(obj) {
      process.stdout.write(JSON.stringify(obj) + '\\n');
    }

    function ok(id, result) {
      send({ jsonrpc: '2.0', id, result });
    }

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

        if (waitingForPermResponse && req.id === 'perm-1') {
          waitingForPermResponse = false;
          setTimeout(() => {
            process.stderr.write('FATAL: simulated transport failure\\n');
          }, 10);
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
          sendPermissionRequest();
          continue;
        }

        ok(id, {});
      }
    });
  `;

  return writeAcpTestAgentScript({
    dir: params.dir,
    fileName: 'fake-acp-agent-permission-first-stderr-fatal.mjs',
    source: src,
  });
}

describe('AcpBackend response completion error preservation', () => {
  it('preserves a fatal stderr error when an unowned late permission request is withdrawn', async () => {
    await withTempDir('happier-acp-stderr-fatal-', async (dir) => {
      let permissionDecisions = 0;
      const backend = new AcpBackend({
        agentName: 'test',
        cwd: dir,
        command: process.execPath,
        args: [writeFakeAcpAgentScript({ dir })],
        transportHandler: createAcpTestTransportHandler({
          idleTimeoutMs: 1,
          handleStderr: () => ({
            message: { type: 'status', status: 'error', detail: 'simulated transport error' },
          }),
        }),
        permissionHandler: {
          async handleToolCall() {
            permissionDecisions++;
            return { decision: 'denied' as const };
          },
        },
      });
      try {
        // The genuine process releases its late request only after the host observed fatal stderr.
        backend.onMessage((message) => {
          if (message.type === 'status' && message.status === 'error' && message.detail === 'simulated transport error') {
            writeFileSync(join(dir, 'fatal-observed'), '');
          }
        });
        const started = await backend.startSession();
        await backend.sendPrompt(started.sessionId, 'hi');
        await expect.poll(async () => JSON.parse(
          await readFileAsync(join(dir, 'withdrawn-permission.json'), 'utf8'),
        )).toEqual({ outcome: { outcome: 'cancelled' } });
        expect(permissionDecisions).toBe(0);
        await expect(backend.waitForResponseComplete(1_000)).rejects.toThrow('simulated transport error');
      } finally {
        await backend.dispose();
      }
    });
  }, 20_000);

  it('prefers a fatal stderr completion error over an earlier permission-denied cancellation', async () => {
    await withTempDir('happier-acp-stderr-fatal-perm-first-', async (dir) => {
      const scriptPath = writeFakeAcpAgentScriptPermissionFirst({ dir });
      let backendForCleanup: AcpBackend | undefined;

      try {
        const backend = new AcpBackend({
          agentName: 'test',
          cwd: dir,
          command: process.execPath,
          args: [scriptPath],
          transportHandler: createAcpTestTransportHandler({
            idleTimeoutMs: 1,
            handleStderr: () => ({
              message: { type: 'status', status: 'error', detail: 'simulated transport error' },
            }),
          }),
          permissionHandler: {
            async handleToolCall() {
              return { decision: 'denied' as const };
            },
          },
        });
        backendForCleanup = backend;

        let promptStarted = false;
        let sawStderrErrorStatus = false;
        let sawStoppedAfterPrompt = false;
        const errorAndStoppedSeen = new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('Timed out waiting for error+stopped statuses')), 10_000);
          backend.onMessage((msg) => {
            if (msg.type !== 'status') return;
            if (msg.status === 'error' && msg.detail === 'simulated transport error') {
              sawStderrErrorStatus = true;
            }
            if (msg.status === 'stopped' && promptStarted) {
              sawStoppedAfterPrompt = true;
            }
            if (sawStderrErrorStatus && sawStoppedAfterPrompt) {
              clearTimeout(timeout);
              resolve();
            }
          });
        });

        const started = await backend.startSession();
        promptStarted = true;
        await backend.sendPrompt(started.sessionId, 'hi');
        await errorAndStoppedSeen;

        await expect(backend.waitForResponseComplete(1_000)).rejects.toThrow('simulated transport error');
      } finally {
        await backendForCleanup?.dispose().catch(() => {});
      }
    });
  }, 20_000);
});
