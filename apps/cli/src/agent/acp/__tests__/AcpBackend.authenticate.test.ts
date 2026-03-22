import { describe, expect, it } from 'vitest';

import { AcpBackend } from '../AcpBackend';
import { writeAcpTestAgentScript } from '../testkit/subprocessHarness';
import { withTempDir } from '@/testkit/fs/tempDir';

function writeFakeAcpAgentScript(params: { dir: string }): string {
  const src = `
    let authenticated = false;
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    let buf = '';

    function send(obj) {
      process.stdout.write(JSON.stringify(obj) + '\\n');
    }

    function respondOk(id, result) {
      send({ jsonrpc: '2.0', id, result });
    }

    function respondErr(id, message) {
      send({ jsonrpc: '2.0', id, error: { code: -32000, message } });
    }

    process.stdin.on('data', (chunk) => {
      buf += decoder.decode(chunk, { stream: true });
      const lines = buf.split('\\n');
      buf = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let req;
        try {
          req = JSON.parse(trimmed);
        } catch {
          continue;
        }
        if (!req || typeof req !== 'object') continue;

        const id = req.id;
        const method = req.method;
        if (id === undefined || id === null || typeof method !== 'string') continue;

        if (method === 'initialize') {
          respondOk(id, {
            protocolVersion: 1,
            authMethods: [{ id: 'openai-api-key', name: 'Use OPENAI_API_KEY' }],
          });
          continue;
        }

        if (method === 'authenticate') {
          authenticated = true;
          respondOk(id, {});
          continue;
        }

        if (method === 'session/new') {
          if (!authenticated) {
            respondErr(id, 'auth required');
            continue;
          }
          respondOk(id, { sessionId: 'test-session' });
          continue;
        }

        respondOk(id, {});
      }
    });
  `;

  return writeAcpTestAgentScript({
    dir: params.dir,
    fileName: 'fake-acp-agent.mjs',
    source: src,
  });
}

describe('AcpBackend auth', () => {
  it('authenticates before creating a session when configured', async () => {
    await withTempDir('happier-acp-auth-', async (dir) => {
      const scriptPath = writeFakeAcpAgentScript({ dir });

      const backend = new AcpBackend({
        agentName: 'test',
        cwd: dir,
        command: process.execPath,
        args: [scriptPath],
        authMethodId: 'openai-api-key',
      });

      try {
        await expect(backend.startSession()).resolves.toEqual({ sessionId: 'test-session' });
      } finally {
        await backend.dispose();
      }
    });
  }, 20_000);
});
