import { describe, expect, it } from 'vitest';

import type { AgentMessage, EventMessage } from '@/agent/core/AgentMessage';
import { createAcpRuntime, type AcpRuntimeBackend } from '../createAcpRuntime';
import type { Metadata } from '@/api/types';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import {
  createApprovedPermissionHandler,
  createBasicSessionClient,
  createDefaultMetadata,
  createFakeAcpRuntimeBackend,
  createSessionClientWithMetadata,
} from '../createAcpRuntime.testkit';

describe('createAcpRuntime (configOptions)', () => {
  it('publishes ACP configOptions into session metadata', async () => {
    const backend = createFakeAcpRuntimeBackend();
    const { session, metadataUpdates, getMetadata } = createSessionClientWithMetadata({
      initialMetadata: createDefaultMetadata(),
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
      initialMetadata: createDefaultMetadata(),
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

    backend.emit({
      type: 'event',
      name: 'config_options_update',
      payload: {
        configOptions: [],
      },
    });

    expect(getMetadata().acpConfigOptionsV1?.configOptions).toEqual([]);
  });

  it('normalizes boolean values before delegating setSessionConfigOption', async () => {
    let lastSet: { sessionId: string; configId: string; value: unknown } | null = null;
    const backend = {
      ...createFakeAcpRuntimeBackend(),
      async setSessionConfigOption(sessionId: string, configId: string, value: unknown) {
        lastSet = { sessionId, configId, value };
      },
    } as AcpRuntimeBackend & { emit: (msg: AgentMessage) => void };

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

    expect(lastSet).toEqual({ sessionId: 'sess_main', configId: 'telemetry', value: 'true' });
  });

  it('trims string values before delegating setSessionConfigOption', async () => {
    let lastSet: { sessionId: string; configId: string; value: unknown } | null = null;
    const backend = {
      ...createFakeAcpRuntimeBackend(),
      async setSessionConfigOption(sessionId: string, configId: string, value: unknown) {
        lastSet = { sessionId, configId, value };
      },
    } as AcpRuntimeBackend & { emit: (msg: AgentMessage) => void };

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
    await runtime.setSessionConfigOption('mode', '  ask  ');

    expect(lastSet).toEqual({ sessionId: 'sess_main', configId: 'mode', value: 'ask' });
  });

  it('refreshes acpSessionModelsV1 when config_options_state model changes', async () => {
    const backend = createFakeAcpRuntimeBackend();
    const { session, getMetadata } = createSessionClientWithMetadata({
      initialMetadata: createDefaultMetadata(),
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
            id: 'model',
            name: 'Model',
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
});
