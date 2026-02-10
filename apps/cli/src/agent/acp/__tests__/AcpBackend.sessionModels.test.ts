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
        if (id === undefined || id === null || typeof method !== 'string') continue;

        if (method === 'initialize') {
          ok(id, { protocolVersion: 1, authMethods: [] });
          continue;
        }

        if (method === 'session/new') {
          ok(id, {
            sessionId: 'test-session',
            models: {
              currentModelId: 'model-a',
              availableModels: [
                { id: 'model-a', name: 'Model A', description: 'Fast' },
                { id: 'model-b', name: 'Model B', description: 'Accurate' },
              ],
            },
          });
          continue;
        }

        if (method === 'session/set_model') {
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

describe('AcpBackend session models', () => {
  it('captures models from newSession and can set the current model', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'happier-acp-models-'));
    const scriptPath = writeFakeAcpAgentScript({ dir });

    let backend: AcpBackend | null = null;
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

      const models = (backend as any).getSessionModelState?.();
      expect(models).toEqual({
        currentModelId: 'model-a',
        availableModels: [
          { id: 'model-a', name: 'Model A', description: 'Fast' },
          { id: 'model-b', name: 'Model B', description: 'Accurate' },
        ],
      });

      expect(events.some((e) => e.type === 'event' && e.name === 'session_models_state')).toBe(true);

      await (backend as any).setSessionModel(started.sessionId, 'model-b');
      const after = (backend as any).getSessionModelState?.();
      expect(after?.currentModelId).toBe('model-b');

      expect(events.some((e) => e.type === 'event' && e.name === 'current_model_update')).toBe(true);
    } finally {
      try {
        await backend?.dispose();
      } catch {}
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects setSessionModel when sessionId does not match the active ACP session', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'happier-acp-models-'));
    const scriptPath = writeFakeAcpAgentScript({ dir });

    let backend: AcpBackend | null = null;
    try {
      backend = new AcpBackend({
        agentName: 'test',
        cwd: dir,
        command: process.execPath,
        args: [scriptPath],
      });

      const started = await backend.startSession();
      expect(started.sessionId).toBe('test-session');

      await expect((backend as any).setSessionModel('not-the-session', 'model-b')).rejects.toThrow(
        /Session ID does not match the active ACP session/,
      );
    } finally {
      try {
        await backend?.dispose();
      } catch {}
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
