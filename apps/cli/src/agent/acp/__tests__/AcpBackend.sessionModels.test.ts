import { describe, expect, it } from 'vitest';

import { AcpBackend } from '../AcpBackend';
import { writeAcpTestAgentScript } from '../testkit/subprocessHarness';
import type { AgentMessage } from '../../core/AgentMessage';
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
                {
                  id: 'model-a',
                  name: 'Model A',
                  description: 'Fast',
                  modelOptions: [
                    {
                      id: 'reasoning_effort',
                      name: 'Thinking',
                      type: 'select',
                      currentValue: 'medium',
                      options: [
                        { value: 'medium', name: 'Medium' },
                        { value: 'high', name: 'High', description: 'More depth' },
                      ],
                    },
                    {
                      id: 'service_tier',
                      name: 'Speed',
                      type: 'select',
                      currentValue: 'fast',
                      options: [
                        { value: 'standard', name: 'Standard' },
                        { value: 'fast', name: 'Fast' },
                      ],
                    },
                  ],
                },
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

  return writeAcpTestAgentScript({
    dir: params.dir,
    fileName: 'fake-acp-agent.mjs',
    source: src,
  });
}

describe('AcpBackend session models', () => {
  it('captures models from newSession and can set the current model', async () => {
    await withTempDir('happier-acp-models-', async (dir) => {
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
            {
              id: 'model-a',
              name: 'Model A',
              description: 'Fast',
              modelOptions: [
                {
                  id: 'reasoning_effort',
                  name: 'Thinking',
                  type: 'select',
                  currentValue: 'medium',
                  options: [
                    { value: 'medium', name: 'Medium' },
                    { value: 'high', name: 'High', description: 'More depth' },
                  ],
                },
                {
                  id: 'service_tier',
                  name: 'Speed',
                  type: 'select',
                  currentValue: 'fast',
                  options: [
                    { value: 'standard', name: 'Standard' },
                    { value: 'fast', name: 'Fast' },
                  ],
                },
              ],
            },
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
      }
    });
  });

  it('rejects setSessionModel when sessionId does not match the active ACP session', async () => {
    await withTempDir('happier-acp-models-', async (dir) => {
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
      }
    });
  });
});
