import { describe, expect, it } from 'vitest';

import type { EventMessage } from '@/agent/core/AgentMessage';
import { createAcpRuntime } from '../createAcpRuntime';
import type { Metadata } from '@/api/types';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { createApprovedPermissionHandler } from '@/testkit/backends/permissionHandler';
import { createBasicSessionClient, createSessionClientWithMetadata } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { createFakeAcpRuntimeBackend } from '@/testkit/backends/acpRuntimeBackend';

describe('createAcpRuntime (session models)', () => {
  it('publishes ACP session models into session metadata', async () => {
    const backend = createFakeAcpRuntimeBackend();
    const { session, metadataUpdates, getMetadata } = createSessionClientWithMetadata({
      initialMetadata: createTestMetadata(),
    });

    const runtime = createAcpRuntime({
      provider: 'codex',
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
    });

    await runtime.startOrLoad({ resumeId: null });

    const modelsEvent: EventMessage = {
      type: 'event',
      name: 'session_models_state',
      payload: {
        currentModelId: 'model-a',
        availableModels: [
          {
            id: 'model-a',
            name: 'Model A',
            modelOptions: [
              {
                id: 'reasoning_effort',
                name: 'Thinking',
                type: 'select',
                currentValue: 'medium',
                options: [
                  { value: 'low', name: 'Low' },
                  { value: 'medium', name: 'Medium' },
                  { value: 'high', name: 'High' },
                ],
              },
            ],
          },
          { id: 'model-b', name: 'Model B', description: 'Accurate' },
        ],
      },
    };
    backend.emit(modelsEvent);

    expect(metadataUpdates.length).toBeGreaterThan(0);
    const metadata: Metadata = getMetadata();
    expect(metadata.acpSessionModelsV1).toMatchObject({
      v: 1,
      provider: 'codex',
      currentModelId: 'model-a',
      availableModels: [
        {
          id: 'model-a',
          name: 'Model A',
          modelOptions: [
            {
              id: 'reasoning_effort',
              name: 'Thinking',
              type: 'select',
              currentValue: 'medium',
              options: [
                { value: 'low', name: 'Low' },
                { value: 'medium', name: 'Medium' },
                { value: 'high', name: 'High' },
              ],
            },
          ],
        },
        { id: 'model-b', name: 'Model B', description: 'Accurate' },
      ],
    });
    expect(typeof metadata.acpSessionModelsV1?.updatedAt).toBe('number');
  });

  it('publishes model options derived from ACP config options when models are absent', async () => {
    const backend = createFakeAcpRuntimeBackend();
    const { session, metadataUpdates, getMetadata } = createSessionClientWithMetadata({
      initialMetadata: createTestMetadata(),
    });

    const runtime = createAcpRuntime({
      provider: 'opencode',
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
    });

    await runtime.startOrLoad({ resumeId: null });

    const configEvent: EventMessage = {
      type: 'event',
      name: 'config_options_state',
      payload: {
        configOptions: [
          {
            id: 'model',
            name: 'Model',
            type: 'enum',
            currentValue: 'model-a',
            options: [
              { value: 'model-a', name: 'Model A' },
              { value: 'model-b', name: 'Model B', description: 'Fast' },
            ],
          },
        ],
      },
    };
    backend.emit(configEvent);

    expect(metadataUpdates.length).toBeGreaterThan(0);
    const metadata: Metadata = getMetadata();
    expect(metadata.acpSessionModelsV1).toMatchObject({
      v: 1,
      provider: 'opencode',
      currentModelId: 'model-a',
      availableModels: [
        { id: 'model-a', name: 'Model A' },
        { id: 'model-b', name: 'Model B', description: 'Fast' },
      ],
    });
  });

  it('delegates setSessionModel to the backend when supported', async () => {
    let lastSet: { sessionId: string; modelId: string } | null = null;
    const backend = createFakeAcpRuntimeBackend({
      async setSessionModel(sessionId: string, modelId: string) {
        lastSet = { sessionId, modelId };
      },
    });

    const runtime = createAcpRuntime({
      provider: 'codex',
      directory: '/tmp',
      session: createBasicSessionClient(),
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
    });

    await runtime.startOrLoad({ resumeId: null });
    await runtime.setSessionModel('model-b');

    expect(lastSet).toEqual({ sessionId: 'sess_main', modelId: 'model-b' });
  });

  it('rejects setSessionModel before the ACP runtime has started', async () => {
    const runtime = createAcpRuntime({
      provider: 'codex',
      directory: '/tmp',
      session: createBasicSessionClient(),
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => createFakeAcpRuntimeBackend(),
    });

    await expect(runtime.setSessionModel('model-b')).rejects.toThrow(/ACP session was not started/);
  });

  it('falls back to session/set_config_option(model=...) when session/set_model is unsupported', async () => {
    let lastSetConfig: { sessionId: string; configId: string; value: unknown } | null = null;
    const backend = createFakeAcpRuntimeBackend({
      async setSessionConfigOption(sessionId: string, configId: string, value: unknown) {
        lastSetConfig = { sessionId, configId, value };
      },
      async setSessionModel(_sessionId: string, _modelId: string) {
        throw new Error('ACP SDK does not support session/set_model');
      },
    });

    const runtime = createAcpRuntime({
      provider: 'codex',
      directory: '/tmp',
      session: createBasicSessionClient(),
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
    });

    await runtime.startOrLoad({ resumeId: null });
    await runtime.setSessionModel('model-b');

    expect(lastSetConfig).toEqual({ sessionId: 'sess_main', configId: 'model', value: 'model-b' });
  });

  it('falls back to config option id "model" when provider model config lookup fails', async () => {
    let lastSetConfig: { sessionId: string; configId: string; value: unknown } | null = null;
    const backend = createFakeAcpRuntimeBackend({
      async setSessionConfigOption(sessionId: string, configId: string, value: unknown) {
        lastSetConfig = { sessionId, configId, value };
      },
      async setSessionModel(_sessionId: string, _modelId: string) {
        throw new Error('ACP SDK does not support session/set_model');
      },
    });

    const runtime = createAcpRuntime({
      provider: 'not-a-real-provider' as any,
      directory: '/tmp',
      session: createBasicSessionClient(),
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
    });

    await runtime.startOrLoad({ resumeId: null });
    await runtime.setSessionModel('model-b');

    expect(lastSetConfig).toEqual({ sessionId: 'sess_main', configId: 'model', value: 'model-b' });
  });
});
