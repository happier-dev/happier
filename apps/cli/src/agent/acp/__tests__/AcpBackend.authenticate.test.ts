import { describe, expect, it } from 'vitest';

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AcpBackend } from '../AcpBackend';

function writeFakeAcpAgentScript(params: { dir: string }): string {
  const scriptPath = join(params.dir, 'fake-acp-agent.mjs');
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

  writeFileSync(scriptPath, src, 'utf8');
  return scriptPath;
}

describe('AcpBackend auth', () => {
  it('authenticates before creating a session when configured', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'happier-acp-auth-'));
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
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
