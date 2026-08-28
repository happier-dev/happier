import { describe, expect, it } from 'vitest';

import { AcpBackend } from '../AcpBackend';
import { writeAcpTestAgentScript } from '../testkit/subprocessHarness';
import { createAcpBackendFromDefinition } from '../runtime/definition/backend';
import { createAcpRuntimeDefinition } from '../runtime/definition/create';
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
        const params = req.params;
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
          if (params && params.modelId === 'reject') {
            send({ jsonrpc: '2.0', id, error: { code: -32000, message: 'model rejected' } });
            continue;
          }
          if (params && params.modelId === 'no-state') {
            ok(id, {});
            continue;
          }
          if (params && params.modelId === 'wrong-state') {
            ok(id, {
              models: {
                currentModelId: 'model-a',
                availableModels: [
                  { id: 'model-a', name: 'Model A' },
                  { id: 'model-b', name: 'Model B', description: 'Accurate' },
                ],
              },
            });
            continue;
          }
          if (params && params._meta && params._meta.reasoningEffort) {
            ok(id, { _meta: { model: { Ok: params.modelId } } });
            continue;
          }
          ok(id, {
            models: {
              currentModelId: params.modelId,
              availableModels: [
                { id: 'model-a', name: 'Model A' },
                { id: 'model-b', name: 'Model B', description: 'Accurate' },
              ],
            },
          });
          continue;
        }

        if (method === 'session/set_config_option') {
          ok(id, {
            configOptions: [{
              id: params.configId,
              name: 'Agent model choice',
              type: 'select',
              currentValue: params.value,
              options: [
                { value: 'model-a', name: 'Model A' },
                { value: 'model-b', name: 'Model B' },
              ],
            }],
          });
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

        expect(events.filter((e) => e.type === 'event' && e.name === 'session_models_state')).toHaveLength(2);
      } finally {
        try {
          await backend?.dispose();
        } catch {}
      }
    });
  });

  it('uses the declarative model config option instead of the legacy model method', async () => {
    await withTempDir('happier-acp-model-config-option-', async (dir) => {
      const backend = await createAcpBackendFromDefinition({
        cwd: dir,
        definition: createAcpRuntimeDefinition({
          backendId: 'test',
          source: { kind: 'account_configured' },
          ux: { title: 'Test ACP' },
          transport: {
            kind: 'stdio',
            launch: {
              kind: 'executable',
              command: process.execPath,
              args: [writeFakeAcpAgentScript({ dir })],
            },
          },
          modelConfigOptionId: 'agent-model-choice',
          mcp: { policy: 'drop' },
        }),
      });
      try {
        const started = await backend.startSession();
        await backend.setSessionModel(started.sessionId, 'model-b');

        expect(backend.getSessionConfigOptionsState()).toEqual([
          expect.objectContaining({
            id: 'agent-model-choice',
            currentValue: 'model-b',
          }),
        ]);
        expect(backend.getSessionModelState()?.currentModelId).toBe('model-a');
      } finally {
        await backend.dispose();
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

  it('does not publish or mutate the current model when the provider rejects the change', async () => {
    await withTempDir('happier-acp-model-rejected-', async (dir) => {
      const backend = new AcpBackend({
        agentName: 'test',
        cwd: dir,
        command: process.execPath,
        args: [writeFakeAcpAgentScript({ dir })],
      });
      const events: AgentMessage[] = [];
      backend.onMessage((message) => {
        if (message.type === 'event') events.push(message);
      });
      try {
        const started = await backend.startSession();
        const updatesBefore = events.filter((event) => (
          event.type === 'event' && event.name === 'current_model_update'
        )).length;

        await expect(backend.setSessionModel(started.sessionId, 'reject')).rejects.toThrow(/model rejected/i);

        expect(backend.getSessionModelState()?.currentModelId).toBe('model-a');
        expect(events.filter((event) => (
          event.type === 'event' && event.name === 'current_model_update'
        ))).toHaveLength(updatesBefore);
      } finally {
        await backend.dispose();
      }
    });
  });

  it('does not report model application success without provider-returned model state', async () => {
    await withTempDir('happier-acp-model-no-state-', async (dir) => {
      const backend = new AcpBackend({
        agentName: 'test',
        cwd: dir,
        command: process.execPath,
        args: [writeFakeAcpAgentScript({ dir })],
      });
      const events: AgentMessage[] = [];
      backend.onMessage((message) => {
        if (message.type === 'event') events.push(message);
      });
      try {
        const started = await backend.startSession();
        const before = backend.getSessionModelState();
        const updatesBefore = events.filter((event) => (
          event.type === 'event' && event.name === 'session_models_state'
        )).length;

        await expect(backend.setSessionModel(started.sessionId, 'no-state'))
          .rejects.toThrow(/did not return model state/i);

        expect(backend.getSessionModelState()).toEqual(before);
        expect(events.filter((event) => (
          event.type === 'event' && event.name === 'session_models_state'
        ))).toHaveLength(updatesBefore);
      } finally {
        await backend.dispose();
      }
    });
  });

  it('uses a provider response projector only after an exact acknowledgement without standard model state', async () => {
    await withTempDir('happier-acp-model-projected-ack-', async (dir) => {
      const backend = new AcpBackend({
        agentName: 'test',
        cwd: dir,
        command: process.execPath,
        args: [writeFakeAcpAgentScript({ dir })],
        projectSetModelResponse: ({ response, requestedModelId, requestMeta, targetModel }) => {
          const acknowledged = (response as { _meta?: { model?: { Ok?: unknown } } })?._meta?.model?.Ok;
          if (acknowledged !== requestedModelId || requestMeta?.reasoningEffort !== 'high') return null;
          return {
            ...targetModel,
            modelOptions: targetModel.modelOptions?.map((option) => option.id === 'reasoning_effort'
              ? { ...option, currentValue: 'high' }
              : option),
          };
        },
      });
      const events: AgentMessage[] = [];
      backend.onMessage((message) => {
        if (message.type === 'event') events.push(message);
      });
      try {
        const started = await backend.startSession();
        await backend.setSessionModel(started.sessionId, 'model-a', { reasoningEffort: 'high' });

        const state = backend.getSessionModelState();
        expect(state?.currentModelId).toBe('model-a');
        expect(state?.availableModels[0]?.modelOptions?.[0]?.currentValue).toBe('high');
        expect(events.filter((event) => (
          event.type === 'event' && event.name === 'session_models_state'
        ))).toHaveLength(2);
      } finally {
        await backend.dispose();
      }
    });
  });

  it('does not report model application success when the provider returns a different current model', async () => {
    await withTempDir('happier-acp-model-wrong-state-', async (dir) => {
      const backend = new AcpBackend({
        agentName: 'test',
        cwd: dir,
        command: process.execPath,
        args: [writeFakeAcpAgentScript({ dir })],
      });
      const events: AgentMessage[] = [];
      backend.onMessage((message) => {
        if (message.type === 'event') events.push(message);
      });
      try {
        const started = await backend.startSession();
        const before = backend.getSessionModelState();
        const updatesBefore = events.filter((event) => (
          event.type === 'event' && event.name === 'session_models_state'
        )).length;

        await expect(backend.setSessionModel(started.sessionId, 'wrong-state'))
          .rejects.toThrow(/different current model/i);

        expect(backend.getSessionModelState()).toEqual(before);
        expect(events.filter((event) => (
          event.type === 'event' && event.name === 'session_models_state'
        ))).toHaveLength(updatesBefore);
      } finally {
        await backend.dispose();
      }
    });
  });
});
