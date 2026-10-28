import { describe, expect, it } from 'vitest';

import type { SessionConfigOption } from '@/agent/acp/AcpBackend';
import type { EventMessage } from '@/agent/core/AgentMessage';
import { createTestAcpRuntime as createAcpRuntime } from '@/testkit/backends/acpRuntime';
import type { Metadata } from '@/api/types';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { createBasicSessionClient, createSessionClientWithMetadata } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { createFakeAcpRuntimeBackend } from '@/testkit/backends/acpRuntimeBackend';
import { createApprovedPermissionHandler } from '@/testkit/backends/permissionHandler';
import { AcpBackend } from '@/agent/acp/AcpBackend';
import { createFx014SessionResponse, writeFx014AcpAgentScript } from '@/agent/acp/testkit/fx014';
import { withTempDir } from '@/testkit/fs/tempDir';

describe('createAcpRuntime (configOptions)', () => {
  it.each([false, true])('projects real FX models and refreshes full setter snapshots (reordered: %s)', async (reordered) => {
    await withTempDir('happier-fx014-runtime-', async (dir) => {
      const response = createFx014SessionResponse();
      const backend = new AcpBackend({
        agentName: 'fx', cwd: dir, command: process.execPath,
        args: [writeFx014AcpAgentScript({ dir, configOptions: reordered ? [...response.configOptions].reverse() : response.configOptions })],
      });
      const { session, getMetadata } = createSessionClientWithMetadata();
      const runtime = createAcpRuntime({
        provider: 'fx', directory: dir, session, messageBuffer: new MessageBuffer(), mcpServers: {},
        permissionHandler: createApprovedPermissionHandler(), onThinkingChange: () => {}, ensureBackend: async () => backend,
      });
      try {
        await runtime.startOrLoad({ resumeId: null });
        const models = () => getMetadata().sessionModelsV1;
        expect(models()?.currentModelId).toBe('gpt-6.1-sol');
        expect(models()?.availableModels.map((model) => model.id)).toEqual(response.configOptions[1].options.map((choice) => choice.value));
        expect(models()?.availableModels.find((model) => model.id === 'gpt-6.1-sol')?.modelOptions?.map((option) => option.id).sort()).toEqual(['effort', 'fast']);
        expect(models()?.availableModels.filter((model) => model.id !== 'gpt-6.1-sol').every((model) => !model.modelOptions)).toBe(true);
        expect(getMetadata().sessionConfigOptionsV1?.configOptions.find((option) => option.id === 'provider')).toEqual(response.configOptions[0]);

        await runtime.setSessionConfigOption('model', 'gpt-6-luna');
        expect(models()?.currentModelId).toBe('gpt-6-luna');
        expect(models()?.availableModels.find((model) => model.id === 'gpt-6-luna')?.modelOptions?.find((option) => option.id === 'effort')?.options?.map((choice) => choice.value)).toEqual(['auto', 'low', 'medium', 'high', 'xhigh', 'max']);
        await runtime.setSessionConfigOption('effort', 'low');
        await runtime.setSessionConfigOption('fast', 'true');
        expect(models()?.availableModels.find((model) => model.id === 'gpt-6-luna')?.modelOptions).toEqual(expect.arrayContaining([
          expect.objectContaining({ id: 'effort', currentValue: 'low' }),
          expect.objectContaining({ id: 'fast', currentValue: 'true' }),
        ]));
        const lastGoodModels = models();
        const lastGoodConfig = getMetadata().sessionConfigOptionsV1;
        await expect(runtime.setSessionConfigOption('provider', 'gateway')).rejects.toThrow(/fx needs access to Vercel AI Gateway/);
        expect(models()).toEqual(lastGoodModels);
        expect(getMetadata().sessionConfigOptionsV1).toEqual(lastGoodConfig);
        await runtime.setSessionConfigOption('provider', 'codex');
        expect(models()?.currentModelId).toBe('gpt-6-luna');
      } finally {
        await backend.dispose();
      }
    });
  });

  it('does not treat ambiguous model-category controls as a model catalog', async () => {
    await withTempDir('happier-acp-ambiguous-runtime-', async (dir) => {
      const configOptions = createFx014SessionResponse().configOptions.filter((option) => option.id !== 'model');
      const backend = new AcpBackend({
        agentName: 'fx', cwd: dir, command: process.execPath,
        args: [writeFx014AcpAgentScript({ dir, configOptions })],
      });
      const { session, getMetadata } = createSessionClientWithMetadata();
      const runtime = createAcpRuntime({
        provider: 'fx', directory: dir, session, messageBuffer: new MessageBuffer(), mcpServers: {},
        permissionHandler: createApprovedPermissionHandler(), onThinkingChange: () => {}, ensureBackend: async () => backend,
      });
      try {
        await runtime.startOrLoad({ resumeId: null });
        expect(getMetadata().sessionModelsV1).toBeUndefined();
        expect(getMetadata().sessionConfigOptionsV1?.configOptions).toEqual(configOptions);
      } finally {
        await backend.dispose();
      }
    });
  });

  it('publishes ACP configOptions into session metadata', async () => {
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
          { id: 'telemetry', name: 'Telemetry', type: 'boolean', currentValue: false },
          {
            id: 'mode',
            name: 'Mode',
            type: 'select',
            currentValue: 'ask',
            options: [{ value: 'ask', name: 'Ask' }],
          },
        ],
      },
    };
    backend.emit(configEvent);

    expect(metadataUpdates.length).toBeGreaterThan(0);
    const metadata: Metadata = getMetadata();
    expect(metadata.acpConfigOptionsV1).toMatchObject({
      v: 1,
      provider: 'opencode',
      configOptions: [
        expect.objectContaining({ id: 'telemetry', type: 'boolean', currentValue: false }),
        expect.objectContaining({ id: 'mode', type: 'select', currentValue: 'ask' }),
      ],
    });
    expect(typeof metadata.acpConfigOptionsV1?.updatedAt).toBe('number');
  });

  it('clears ACP configOptions metadata when the provider reports an empty list', async () => {
    const backend = createFakeAcpRuntimeBackend();
    const { session, getMetadata } = createSessionClientWithMetadata({
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

    backend.emit({
      type: 'event',
      name: 'config_options_state',
      payload: {
        configOptions: [
          { id: 'telemetry', name: 'Telemetry', type: 'boolean', currentValue: false },
        ],
      },
    });

    expect(getMetadata().acpConfigOptionsV1?.configOptions).toHaveLength(1);

    backend.emit({ type: 'event', name: 'config_options_update', payload: {} });
    expect(getMetadata().acpConfigOptionsV1?.configOptions).toHaveLength(1);

    backend.emit({
      type: 'event',
      name: 'config_options_update',
      payload: {
        configOptions: [],
      },
    });

    expect(getMetadata().acpConfigOptionsV1?.configOptions).toEqual([]);
  });

  it('preserves boolean values before delegating setSessionConfigOption', async () => {
    let lastSet: { sessionId: string; configId: string; value: unknown } | null = null;
    const backend = createFakeAcpRuntimeBackend({
      async setSessionConfigOption(sessionId: string, configId: string, value: unknown) {
        lastSet = { sessionId, configId, value };
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
    await runtime.setSessionConfigOption('telemetry', true);

    expect(lastSet).toEqual({ sessionId: 'sess_main', configId: 'telemetry', value: true });
  });

  it('lets providers translate virtual model option changes before delegating config controls', async () => {
    let lastSet: { sessionId: string; configId: string; value: unknown } | null = null;
    const backend = createFakeAcpRuntimeBackend({
      async setSessionConfigOption(sessionId: string, configId: string, value: unknown) {
        lastSet = { sessionId, configId, value };
      },
    });
    const backendWithConfig = backend as typeof backend & {
      getSessionConfigOptionsState: () => ReadonlyArray<SessionConfigOption>;
    };
    backendWithConfig.getSessionConfigOptionsState = () => [{
      id: 'model',
      name: 'Model',
      type: 'select',
      currentValue: 'gpt-5.5[context=272k,reasoning=medium,fast=false]',
      options: [
        { value: 'gpt-5.5[context=272k,reasoning=medium,fast=false]', name: 'GPT-5.5' },
        { value: 'gpt-5.5[context=272k,reasoning=high,fast=false]', name: 'GPT-5.5' },
      ],
    }];

    const runtime = createAcpRuntime({
      provider: 'cursor',
      directory: '/tmp',
      session: createBasicSessionClient(),
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backendWithConfig,
      resolveSessionConfigOptionUpdate: ({ configId, value, configOptions }) => {
        expect(configOptions).toHaveLength(1);
        if (configId === 'reasoning_effort' && value === 'high') {
          return { modelId: 'gpt-5.5[context=272k,reasoning=high,fast=false]' };
        }
        return { configId, value };
      },
    });

    await runtime.startOrLoad({ resumeId: null });
    await runtime.setSessionConfigOption('reasoning_effort', 'high');

    expect(lastSet).toEqual({
      sessionId: 'sess_main',
      configId: 'model',
      value: 'gpt-5.5[context=272k,reasoning=high,fast=false]',
    });
  });

  it('preserves exact nonblank config identifiers and values before delegating setSessionConfigOption', async () => {
    let lastSet: { sessionId: string; configId: string; value: unknown } | null = null;
    const backend = createFakeAcpRuntimeBackend({
      async setSessionConfigOption(sessionId: string, configId: string, value: unknown) {
        lastSet = { sessionId, configId, value };
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
    await runtime.setSessionConfigOption(' mode ', '  ask  ');

    expect(lastSet).toEqual({ sessionId: 'sess_main', configId: ' mode ', value: '  ask  ' });
  });

  it('refreshes acpSessionModelsV1 when config_options_state model changes', async () => {
    const backend = createFakeAcpRuntimeBackend();
    const { session, getMetadata } = createSessionClientWithMetadata({
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

    backend.emit({
      type: 'event',
      name: 'config_options_state',
      payload: {
        configOptions: [
          {
            id: 'cursor-choice',
            name: 'Cursor Choice',
            category: 'model',
            type: 'select',
            currentValue: 'claude-3',
            options: [
              { value: 'claude-3', name: 'Claude 3' },
              { value: 'claude-4', name: 'Claude 4' },
            ],
          },
        ],
      },
    });

    backend.emit({
      type: 'event',
      name: 'config_options_state',
      payload: {
        configOptions: [
          {
            id: 'model',
            name: 'Model',
            type: 'select',
            currentValue: 'claude-4',
            options: [
              { value: 'claude-3', name: 'Claude 3' },
              { value: 'claude-4', name: 'Claude 4' },
            ],
          },
        ],
      },
    });

    expect(getMetadata().acpSessionModelsV1).toMatchObject({
      provider: 'opencode',
      currentModelId: 'claude-4',
    });
  });

  it('derives ACP session models from grouped config option choices', async () => {
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
            id: 'model',
            name: 'Model',
            type: 'select',
            currentValue: 'default[]',
            options: [
              {
                group: 'cursor',
                name: 'Cursor',
                options: [
                  { value: 'default[]', name: 'Default' },
                  { value: 'composer-2.5[fast=true]', name: 'Composer 2.5 Fast' },
                ],
              },
            ],
          },
        ],
      },
    });

    expect(getMetadata().acpSessionModelsV1).toMatchObject({
      provider: 'cursor',
      currentModelId: 'default[]',
      availableModels: [
        { id: 'default[]', name: 'Default' },
        { id: 'composer-2.5[fast=true]', name: 'Composer 2.5 Fast' },
      ],
    });
  });
});
