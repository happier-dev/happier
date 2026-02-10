import { describe, expect, it } from 'vitest';

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AcpBackend } from '../AcpBackend';
import type { AgentMessage } from '../../core/AgentMessage';

function writeFakeAcpAgentScript(params: { dir: string }): string {
  const scriptPath = join(params.dir, 'fake-acp-agent.mjs');
  const src = `
    const decoder = new TextDecoder();
    let buf = '';

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
        let req;
        try { req = JSON.parse(trimmed); } catch { continue; }
        if (!req || typeof req !== 'object') continue;
        const id = req.id;
        const method = req.method;
        const params = req.params;
        if (id === undefined || id === null || typeof method !== 'string') continue;

        if (method === 'initialize') {
          ok(id, { protocolVersion: 1, authMethods: [] });
          continue;
        }

        if (method === 'session/new') {
          ok(id, {
            sessionId: 'test-session',
            modes: {
              currentModeId: 'ask',
              availableModes: [
                { id: 'ask', name: 'Ask', description: 'Ask before changes' },
                { id: 'code', name: 'Code', description: 'Write code' },
              ],
            },
          });
          continue;
        }

        if (method === 'session/set_mode') {
          // Echo OK. The backend should treat success as mode switch completion.
          ok(id, {});
          continue;
        }

        ok(id, {});
      }
    });
  `;

  writeFileSync(scriptPath, src, 'utf8');
  return scriptPath;
}

describe('AcpBackend session modes', () => {
  it('captures modes from newSession and can set the current mode', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'happier-acp-modes-'));
    const scriptPath = writeFakeAcpAgentScript({ dir });

    let backend: AcpBackend | undefined;
    try {
      backend = new AcpBackend({
        agentName: 'test',
        cwd: dir,
        command: process.execPath,
        args: [scriptPath],
      });

      const events: AgentMessage[] = [];
      backend.onMessage((msg) => {
        if (msg.type === 'event') events.push(msg);
      });

      const started = await backend.startSession();
      expect(started.sessionId).toBe('test-session');

      const modes = backend.getSessionModeState();
      expect(modes).toEqual({
        currentModeId: 'ask',
        availableModes: [
          { id: 'ask', name: 'Ask', description: 'Ask before changes' },
          { id: 'code', name: 'Code', description: 'Write code' },
        ],
      });

      expect(events.some((e) => e.type === 'event' && e.name === 'session_modes_state')).toBe(true);

      await backend.setSessionMode(started.sessionId, 'code');
      const after = backend.getSessionModeState();
      expect(after?.currentModeId).toBe('code');

      expect(events.some((e) => e.type === 'event' && e.name === 'current_mode_update')).toBe(true);
    } finally {
      await backend?.dispose().catch(() => {});
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects setSessionMode when sessionId does not match the active ACP session', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'happier-acp-modes-'));
    const scriptPath = writeFakeAcpAgentScript({ dir });

    let backend: AcpBackend | undefined;
    try {
      backend = new AcpBackend({
        agentName: 'test',
        cwd: dir,
        command: process.execPath,
        args: [scriptPath],
      });

      const started = await backend.startSession();
      expect(started.sessionId).toBe('test-session');

      await expect(backend.setSessionMode('not-the-session', 'code')).rejects.toThrow(
        /Session ID does not match the active ACP session/,
      );
    } finally {
      await backend?.dispose().catch(() => {});
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
