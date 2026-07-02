import { describe, expect, it, vi } from 'vitest';

import type { Credentials } from '@/persistence';

import { createPluginRuntimeCoreFactory } from './index';

function createRuntimeTurnOperations() {
  return {
    beginTurnLifecycle: vi.fn(),
    startOrLoadSession: vi.fn(async () => undefined),
    sendTurnPrompt: vi.fn(async () => undefined),
    steerInFlightTurn: vi.fn(async () => undefined),
    waitForTurnCompletion: vi.fn(async () => undefined),
    subscribeRuntimeEvents: vi.fn(() => () => undefined),
    respondToPermission: vi.fn(async () => undefined),
    cancelTurn: vi.fn(async () => undefined),
    readSessionIdentity: vi.fn(() => ({ sessionId: 'plugin-session-1' })),
    updateSessionRuntimeConfig: vi.fn(async () => undefined),
    resetOrDisposeRuntime: vi.fn(async () => undefined),
  };
}

function createBindingFactory(params: Readonly<{
  launch: (params: unknown) => Promise<unknown>;
}>) {
  return createPluginRuntimeCoreFactory({
    backend: {
      id: 'acme.sample.backend',
      providerId: 'acme.sample.provider',
      provenance: 'external',
      source: { kind: 'path' },
      runtimeKind: 'native',
      capabilities: {},
      richDefinition: {
        provenance: 'external',
        definition: {
          providerAgentId: 'claude',
        },
      },
      definition: {
        id: 'acme.sample.backend',
        providerId: 'acme.sample.provider',
        providerAgentId: 'claude',
      },
    } as never,
    provider: {
      id: 'acme.sample.provider',
      provenance: 'external',
      source: { kind: 'path' },
      richDefinition: {
        provenance: 'external',
        definition: {
          providerAgentId: 'claude',
        },
      },
      runtimeSpec: {
        title: 'Acme Sample Provider',
      },
      definition: {
        id: 'acme.sample.provider',
        ownedBackendIds: ['acme.sample.backend'],
        providerAgentId: 'claude',
      },
    } as never,
  })({
    backend: {
      id: 'acme.sample.backend',
      providerId: 'acme.sample.provider',
      provenance: 'external',
      source: { kind: 'path' },
      runtimeKind: 'native',
      capabilities: {},
      richDefinition: {
        provenance: 'external',
        definition: {
          providerAgentId: 'claude',
        },
      },
      definition: {
        id: 'acme.sample.backend',
        providerId: 'acme.sample.provider',
        providerAgentId: 'claude',
      },
    } as never,
    provider: {
      id: 'acme.sample.provider',
      provenance: 'external',
      source: { kind: 'path' },
      richDefinition: {
        provenance: 'external',
        definition: {
          providerAgentId: 'claude',
        },
      },
      runtimeSpec: {
        title: 'Acme Sample Provider',
      },
      definition: {
        id: 'acme.sample.provider',
        ownedBackendIds: ['acme.sample.backend'],
        providerAgentId: 'claude',
      },
    } as never,
    executionSurfaces: {
      terminalRuntime: {
        launch: params.launch,
      } as never,
      externalSession: null,
      attach: null,
      handoff: null,
      fork: null,
      checkpoint: null,
    },
  });
}

describe('createPluginRuntimeCoreFactory', () => {
  it('returns an explicit runtimeCore envelope instead of a bare runtime object', () => {
    const runtimeCore = createBindingFactory({
      launch: async () => createRuntimeTurnOperations(),
    });

    expect('runtimeCore' in runtimeCore).toBe(true);
    expect('createSessionRuntime' in runtimeCore).toBe(false);
  });

  it('rejects raw RuntimeTurnOperations launch results and requires an explicit runtime payload envelope', async () => {
    const credentials: Credentials = {
      token: 'test-token',
      encryption: {
        type: 'legacy',
        secret: new Uint8Array([1, 2, 3]),
      },
    };
    const runtimeCore = createBindingFactory({
      launch: async () => createRuntimeTurnOperations(),
    });

    if (!('runtimeCore' in runtimeCore)) {
      throw new Error('expected plugin runtimeCore to return a runtimeCore envelope');
    }

    const plan = await runtimeCore.runtimeCore.createSessionRuntime({
      credentials,
      directory: '/tmp/plugin-backend',
    });
    const createSessionRuntime = plan.config.createSessionRuntime;
    if (typeof createSessionRuntime !== 'function') {
      throw new Error('expected plugin host session plan to materialize createSessionRuntime');
    }

    await expect(createSessionRuntime({
      directory: '/tmp/plugin-backend',
      metadata: {} as never,
      machineId: 'machine-1',
      session: {} as never,
      transcriptSession: {} as never,
      messageBuffer: {} as never,
      mcpServers: {},
      permissionHandler: {} as never,
      getPermissionMode: () => 'default',
      setThinking: () => undefined,
      memoryRecallGuidanceEnabled: false,
    })).rejects.toThrow(
      /must return an object payload with RuntimeTurnOperations/i,
    );
  });

  it('rejects session launch payloads that still use bindings instead of runtime', async () => {
    const credentials: Credentials = {
      token: 'test-token',
      encryption: {
        type: 'legacy',
        secret: new Uint8Array([1, 2, 3]),
      },
    };
    const runtimeCore = createBindingFactory({
      launch: async () => ({
        bindings: createRuntimeTurnOperations(),
      }),
    });

    if (!('runtimeCore' in runtimeCore)) {
      throw new Error('expected plugin runtimeCore to return a runtimeCore envelope');
    }

    const plan = await runtimeCore.runtimeCore.createSessionRuntime({
      credentials,
      directory: '/tmp/plugin-backend',
    });
    if (typeof plan.config.createSessionRuntime !== 'function') {
      throw new Error('expected plugin host session plan to materialize createSessionRuntime');
    }

    const createSessionRuntime = plan.config.createSessionRuntime;
    if (typeof createSessionRuntime !== 'function') {
      throw new Error('expected plugin host session plan to materialize createSessionRuntime');
    }

    await expect(createSessionRuntime({
      directory: '/tmp/plugin-backend',
      metadata: {} as never,
      machineId: 'machine-1',
      session: {} as never,
      transcriptSession: {} as never,
      messageBuffer: {} as never,
      mcpServers: {},
      permissionHandler: {} as never,
      getPermissionMode: () => 'default',
      setThinking: () => undefined,
      memoryRecallGuidanceEnabled: false,
    })).rejects.toThrow(
      /must include RuntimeTurnOperations/i,
    );
  });

  it('passes only the plugin session launch request to plugin terminal launch', async () => {
    const credentials: Credentials = {
      token: 'test-token',
      encryption: {
        type: 'legacy',
        secret: new Uint8Array([1, 2, 3]),
      },
    };
    const launch = vi.fn(async () => ({
      runtime: createRuntimeTurnOperations(),
    }));
    const runtimeCore = createBindingFactory({ launch });

    if (!('runtimeCore' in runtimeCore)) {
      throw new Error('expected plugin runtimeCore to return a runtimeCore envelope');
    }

    const plan = await runtimeCore.runtimeCore.createSessionRuntime({
      credentials,
      directory: '/tmp/plugin-backend',
      backendTarget: {
        kind: 'provider',
        providerId: 'acme.sample.provider',
      },
      startedBy: 'daemon',
      terminalRuntime: { mode: 'headless' },
      permissionMode: 'acceptEdits',
      permissionModeUpdatedAt: 12,
      sessionModeId: 'session-mode-1',
      sessionModeUpdatedAt: 34,
      modelId: 'model-1',
      modelUpdatedAt: 56,
      existingSessionId: 'existing-session-1',
      resume: 'resume-1',
      accountSettingsContext: { source: 'bootstrap' },
    });
    const createSessionRuntime = plan.config.createSessionRuntime;
    if (typeof createSessionRuntime !== 'function') {
      throw new Error('expected plugin host session plan to materialize createSessionRuntime');
    }

    await createSessionRuntime({
      directory: '/tmp/plugin-backend',
      metadata: { machine: 'host-only' } as never,
      machineId: 'machine-1',
      session: { sessionId: 'host-session-1' } as never,
      transcriptSession: {} as never,
      messageBuffer: {} as never,
      mcpServers: { sample: { type: 'stdio', command: 'echo' } } as never,
      permissionHandler: {} as never,
      getPermissionMode: () => 'default',
      setThinking: () => undefined,
      memoryRecallGuidanceEnabled: false,
    });

    expect(launch).toHaveBeenCalledTimes(1);
    expect(launch).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'host-session-1',
      directory: '/tmp/plugin-backend',
      metadata: { machine: 'host-only' },
      backend: {
        id: 'acme.sample.backend',
        providerId: 'acme.sample.provider',
      },
      credentials,
      bootstrap: expect.objectContaining({
        workingDirectory: '/tmp/plugin-backend',
        target: {
          kind: 'provider',
          providerId: 'acme.sample.provider',
        },
        source: 'daemon',
        accountSettingsContext: { source: 'bootstrap' },
      }),
      resume: expect.objectContaining({
        existingSessionId: 'existing-session-1',
        resumeSessionId: 'resume-1',
      }),
      runtimePreferences: expect.objectContaining({
        terminal: { mode: 'headless' },
        permission: {
          mode: 'acceptEdits',
          updatedAt: 12,
        },
        sessionMode: {
          id: 'session-mode-1',
          updatedAt: 34,
        },
        model: {
          id: 'model-1',
          updatedAt: 56,
        },
      }),
    }));

    const launchCall = launch.mock.calls[0] as unknown[] | undefined;
    expect(launchCall).toBeDefined();
    if (!launchCall) {
      throw new Error('expected plugin terminal launch to be called');
    }
    const launchParamsRecord = launchCall.at(0) as Record<string, unknown>;
    expect(launchParamsRecord).not.toHaveProperty('backendId');
    expect(launchParamsRecord).not.toHaveProperty('providerId');
    expect(launchParamsRecord).not.toHaveProperty('backendTarget');
    expect(launchParamsRecord).not.toHaveProperty('startedBy');
    expect(launchParamsRecord).not.toHaveProperty('terminalRuntime');
    expect(launchParamsRecord).not.toHaveProperty('permissionMode');
    expect(launchParamsRecord).not.toHaveProperty('permissionModeUpdatedAt');
    expect(launchParamsRecord).not.toHaveProperty('sessionModeId');
    expect(launchParamsRecord).not.toHaveProperty('sessionModeUpdatedAt');
    expect(launchParamsRecord).not.toHaveProperty('modelId');
    expect(launchParamsRecord).not.toHaveProperty('modelUpdatedAt');
    expect(launchParamsRecord).not.toHaveProperty('existingSessionId');
    expect(launchParamsRecord.resume).toEqual({
      existingSessionId: 'existing-session-1',
      resumeSessionId: 'resume-1',
    });
    expect(launchParamsRecord).not.toHaveProperty('accountSettingsContext');
    expect(launchParamsRecord).not.toHaveProperty('hostOptions');
    expect(launchParamsRecord).not.toHaveProperty('machineId');
    expect(launchParamsRecord).not.toHaveProperty('session');
    expect(launchParamsRecord).not.toHaveProperty('transcriptSession');
    expect(launchParamsRecord).not.toHaveProperty('messageBuffer');
    expect(launchParamsRecord).not.toHaveProperty('mcpServers');
    expect(launchParamsRecord).not.toHaveProperty('permissionHandler');
    expect(launchParamsRecord).not.toHaveProperty('getPermissionMode');
    expect(launchParamsRecord).not.toHaveProperty('setThinking');
    expect(launchParamsRecord).not.toHaveProperty('memoryRecallGuidanceEnabled');
  });

});
