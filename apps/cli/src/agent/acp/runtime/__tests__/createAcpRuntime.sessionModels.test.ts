import { describe, expect, it } from 'vitest';

import type { EventMessage } from '@/agent/core/AgentMessage';
import type { SessionConfigOption } from '@/agent/acp/AcpBackend';
import { createTestAcpRuntime as createAcpRuntime } from '@/testkit/backends/acpRuntime';
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
    expect(metadata.sessionModelsV1).toEqual(metadata.acpSessionModelsV1);
  });

  it('publishes ACP session models emitted while loading a resumed session', async () => {
    const backend = createFakeAcpRuntimeBackend();
    backend.loadSession = async () => {
      backend.emit({
        type: 'event',
        name: 'session_models_state',
        payload: {
          currentModelId: 'model-a',
          availableModels: [
            { id: 'model-a', name: 'Model A' },
            { id: 'model-b', name: 'Model B' },
          ],
        },
      });
      return { sessionId: 'sess_main' };
    };
    const { session, getMetadata } = createSessionClientWithMetadata({
      initialMetadata: createTestMetadata(),
    });

    const runtime = createAcpRuntime({
      provider: 'pi',
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
    });

    await runtime.startOrLoad({ resumeId: 'sess_main' });

    expect(getMetadata().sessionModelsV1).toMatchObject({
      provider: 'pi',
      currentModelId: 'model-a',
      availableModels: [
        { id: 'model-a', name: 'Model A' },
        { id: 'model-b', name: 'Model B' },
      ],
    });
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

  it('attaches ACP model_config options to models derived from config options', async () => {
    const backend = createFakeAcpRuntimeBackend();
    const { session, getMetadata } = createSessionClientWithMetadata({
      initialMetadata: createTestMetadata(),
    });

    const runtime = createAcpRuntime({
      provider: 'cursor',
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
    });

    await runtime.startOrLoad({ resumeId: null });

    backend.emit({
      type: 'event',
      name: 'config_options_state',
      payload: {
        configOptions: [
          {
            id: 'mode',
            name: 'Mode',
            category: 'mode',
            type: 'select',
            currentValue: 'agent',
            options: [{ value: 'agent', name: 'Agent' }],
          },
          {
            id: 'model',
            name: 'Model',
            category: 'model',
            type: 'select',
            currentValue: 'composer-2.5',
            options: [
              { value: 'composer-2.5', name: 'Composer 2.5' },
              { value: 'gpt-5.5', name: 'GPT-5.5' },
            ],
          },
          {
            id: 'fast',
            name: 'Fast',
            category: 'model_config',
            type: 'select',
            currentValue: 'true',
            options: [
              { value: 'false', name: 'Off' },
              { value: 'true', name: 'Fast' },
            ],
          },
          {
            id: 'telemetry',
            name: 'Telemetry',
            category: 'session',
            type: 'boolean',
            currentValue: false,
          },
        ],
      },
    });

    expect(getMetadata().acpSessionModelsV1?.availableModels).toEqual([
      {
        id: 'composer-2.5',
        name: 'Composer 2.5',
        modelOptions: [
          {
            id: 'fast',
            name: 'Fast',
            category: 'model_config',
            type: 'select',
            currentValue: 'true',
            options: [
              { value: 'false', name: 'Off' },
              { value: 'true', name: 'Fast' },
            ],
          },
        ],
      },
      {
        id: 'gpt-5.5',
        name: 'GPT-5.5',
        modelOptions: [
          {
            id: 'fast',
            name: 'Fast',
            category: 'model_config',
            type: 'select',
            currentValue: 'true',
            options: [
              { value: 'false', name: 'Off' },
              { value: 'true', name: 'Fast' },
            ],
          },
        ],
      },
    ]);
  });

  it('uses a provider-owned config option model derivation hook when present', async () => {
    const backend = createFakeAcpRuntimeBackend();
    const { session, getMetadata } = createSessionClientWithMetadata({
      initialMetadata: createTestMetadata(),
    });

    const runtime = createAcpRuntime({
      provider: 'cursor',
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
      deriveSessionModelsFromConfigOptions: (configOptions) => {
        expect(configOptions.map((option) => option.id)).toEqual(['model']);
        return {
          currentModelId: 'gpt-5.5',
          availableModels: [{
            id: 'gpt-5.5',
            name: 'GPT-5.5',
            modelOptions: [{
              id: 'reasoning_effort',
              name: 'Reasoning effort',
              category: 'model_config',
              type: 'select',
              currentValue: 'medium',
              options: [
                { value: 'medium', name: 'Medium' },
                { value: 'high', name: 'High' },
              ],
            }],
          }],
        };
      },
    });

    await runtime.startOrLoad({ resumeId: null });

    backend.emit({
      type: 'event',
      name: 'config_options_state',
      payload: {
        configOptions: [{
          id: 'model',
          name: 'Model',
          category: 'model',
          type: 'select',
          currentValue: 'gpt-5.5[reasoning=medium]',
          options: [
            { value: 'gpt-5.5[reasoning=medium]', name: 'GPT-5.5' },
            { value: 'gpt-5.5[reasoning=high]', name: 'GPT-5.5' },
          ],
        }],
      },
    });

    expect(getMetadata().acpSessionModelsV1).toMatchObject({
      currentModelId: 'gpt-5.5',
      availableModels: [{
        id: 'gpt-5.5',
        modelOptions: [expect.objectContaining({ id: 'reasoning_effort' })],
      }],
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

  it('preserves exact nonblank model identifiers when delegating to the backend', async () => {
    let lastSet: { sessionId: string; modelId: string } | null = null;
    const backend = createFakeAcpRuntimeBackend({
      async setSessionModel(sessionId: string, modelId: string) {
        lastSet = { sessionId, modelId };
      },
    });
    const runtime = createAcpRuntime({
      provider: 'opencode',
      directory: '/tmp',
      session: createBasicSessionClient(),
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
    });

    await runtime.startOrLoad({ resumeId: null });
    await runtime.setSessionModel(' model-b ');

    expect(lastSet).toEqual({ sessionId: 'sess_main', modelId: ' model-b ' });
  });

  it('uses the model config option directly for providers that require config-option model switching', async () => {
    let modelSetCalls = 0;
    let lastSetConfig: { sessionId: string; configId: string; value: unknown } | null = null;
    const backend = createFakeAcpRuntimeBackend({
      async setSessionModel() {
        modelSetCalls += 1;
      },
      async setSessionConfigOption(sessionId: string, configId: string, value: unknown) {
        lastSetConfig = { sessionId, configId, value };
      },
    });

    const runtime = createAcpRuntime({
      provider: 'cursor',
      directory: '/tmp',
      session: createBasicSessionClient(),
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
    });

    await runtime.startOrLoad({ resumeId: null });
    await runtime.setSessionModel('composer-2.5[fast=true]');

    expect(modelSetCalls).toBe(0);
    expect(lastSetConfig).toEqual({
      sessionId: 'sess_main',
      configId: 'model',
      value: 'composer-2.5[fast=true]',
    });
  });

  it('lets config-option providers resolve CLI model aliases before applying model controls', async () => {
    const calls: Array<{ configId: string; value: unknown }> = [];
    const backend = createFakeAcpRuntimeBackend({
      async setSessionConfigOption(_sessionId: string, configId: string, value: unknown) {
        calls.push({ configId, value });
      },
    });
    const backendWithConfig = backend as typeof backend & {
      getSessionConfigOptionsState: () => ReadonlyArray<SessionConfigOption>;
    };
    backendWithConfig.getSessionConfigOptionsState = () => [
      {
        id: 'model',
        name: 'Model',
        type: 'select',
        currentValue: 'gpt-5.1-codex-max[reasoning=medium,fast=false]',
        options: [
          {
            value: 'gpt-5.1-codex-max[reasoning=medium,fast=false]',
            name: 'GPT-5.1 Codex Max',
          },
        ],
      },
      {
        id: 'fast',
        name: 'Fast',
        type: 'boolean',
        currentValue: 'false',
      },
    ];

    const runtime = createAcpRuntime({
      provider: 'cursor',
      directory: '/tmp',
      session: createBasicSessionClient(),
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backendWithConfig,
      resolveSessionModelConfigUpdate: ({ modelId, configOptions }) => {
        if (modelId !== 'gpt-5.1-codex-max-medium-fast') {
          return { modelId };
        }
        expect(configOptions).toHaveLength(2);
        return {
          modelId: 'gpt-5.1-codex-max[reasoning=medium,fast=false]',
          configUpdates: [{ configId: 'fast', value: true }],
        };
      },
    });

    await runtime.startOrLoad({ resumeId: null });
    await runtime.setSessionModel('gpt-5.1-codex-max-medium-fast');

    expect(calls).toEqual([
      { configId: 'model', value: 'gpt-5.1-codex-max[reasoning=medium,fast=false]' },
      { configId: 'fast', value: true },
    ]);
  });

  it('does not apply a model update when the provider resolver rejects it', async () => {
    const calls: Array<{ configId: string; value: unknown }> = [];
    const backend = createFakeAcpRuntimeBackend({
      async setSessionConfigOption(_sessionId: string, configId: string, value: unknown) {
        calls.push({ configId, value });
      },
    });

    const runtime = createAcpRuntime({
      provider: 'cursor',
      directory: '/tmp',
      session: createBasicSessionClient(),
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
      resolveSessionModelConfigUpdate: () => null,
    });

    await runtime.startOrLoad({ resumeId: null });
    await runtime.setSessionModel('not-a-cursor-acp-choice');

    expect(calls).toEqual([]);
  });

  it('applies startup metadata model overrides before deferred pending queue drain', async () => {
    const calls: string[] = [];
    const backend = createFakeAcpRuntimeBackend({
      async startSession() {
        calls.push('start');
        return { sessionId: 'sess_main' };
      },
      async setSessionConfigOption(_sessionId: string, configId: string, value: unknown) {
        calls.push(`config:${configId}:${String(value)}`);
      },
    });
    const { session, getMetadata } = createSessionClientWithMetadata({
      initialMetadata: {
        ...createTestMetadata(),
        modelOverrideV1: { v: 1, updatedAt: 11, modelId: 'composer-2.5[fast=true]' },
      } as Metadata,
    });
    const sessionWithSnapshot = {
      ...session,
      getMetadataSnapshot: getMetadata,
    };
    const runtime = createAcpRuntime({
      provider: 'cursor',
      directory: '/tmp',
      session: sessionWithSnapshot,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
      pendingQueue: {
        drainAfterStartOrLoad: true,
        inputConsumer: {
          drainPending: async () => {
            calls.push('drain');
            return { materialized: 0, stoppedReason: 'no_pending' };
          },
        },
      },
    });

    await runtime.startOrLoad({ deferPendingDrain: true });
    await runtime.drainPendingAfterStartOrLoad();

    expect(calls).toEqual([
      'start',
      'config:model:composer-2.5[fast=true]',
      'drain',
    ]);
  });

  it('applies explicit startup model overrides before deferred pending queue drain', async () => {
    const calls: string[] = [];
    const backend = createFakeAcpRuntimeBackend({
      async startSession() {
        calls.push('start');
        return { sessionId: 'sess_main' };
      },
      async setSessionConfigOption(_sessionId: string, configId: string, value: unknown) {
        calls.push(`config:${configId}:${String(value)}`);
      },
    });
    const { session } = createSessionClientWithMetadata({
      initialMetadata: createTestMetadata(),
    });

    const runtime = createAcpRuntime({
      provider: 'cursor',
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
      startupOverrides: {
        model: { modelId: 'composer-2.5[fast=true]' },
      },
      pendingQueue: {
        drainAfterStartOrLoad: true,
        inputConsumer: {
          drainPending: async () => {
            calls.push('drain');
            return { materialized: 0, stoppedReason: 'no_pending' };
          },
        },
      },
    });

    await runtime.startOrLoad({ deferPendingDrain: true });
    await runtime.drainPendingAfterStartOrLoad();

    expect(calls).toEqual([
      'start',
      'config:model:composer-2.5[fast=true]',
      'drain',
    ]);
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

  it('surfaces session/set_model errors when the provider declares no config-option fallback', async () => {
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
      provider: 'grok',
      directory: '/tmp',
      session: createBasicSessionClient(),
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
    });

    await runtime.startOrLoad({ resumeId: null });
    await expect(runtime.setSessionModel('model-b')).rejects.toThrow('ACP SDK does not support session/set_model');

    expect(lastSetConfig).toBeNull();
  });
});
