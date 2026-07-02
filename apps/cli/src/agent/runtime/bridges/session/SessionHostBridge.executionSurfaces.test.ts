import { beforeEach, describe, expect, it, vi } from 'vitest';

const resolveBackendEngineAdapterResolutionMock = vi.fn();
const resolveBackendExecutionSurfacesMock = vi.fn();
const runHostSessionRuntimePlanMock = vi.fn();

vi.mock('@/agent/runtime/registry/engineRegistry', () => ({
  resolveBackendEngineAdapterResolution: (...args: unknown[]) => resolveBackendEngineAdapterResolutionMock(...args),
  resolveBackendExecutionSurfaces: (...args: unknown[]) => resolveBackendExecutionSurfacesMock(...args),
}));

vi.mock('@/agent/runtime/session/loop/lifecycle', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/agent/runtime/session/loop/lifecycle')>();
  return {
    ...actual,
    runHostSessionRuntimePlan: (...args: unknown[]) => runHostSessionRuntimePlanMock(...args),
  };
});

import { SessionHostBridge } from './SessionHostBridge';

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
    readSessionIdentity: vi.fn(() => ({ sessionId: 'session-1' })),
    updateSessionRuntimeConfig: vi.fn(async () => undefined),
    resetOrDisposeRuntime: vi.fn(async () => undefined),
  };
}

describe('SessionHostBridge execution surfaces', () => {
  beforeEach(() => {
    resolveBackendEngineAdapterResolutionMock.mockReset();
    resolveBackendExecutionSurfacesMock.mockReset();
    runHostSessionRuntimePlanMock.mockReset();
  });

  it('resolves plugin-defined backend execution surfaces through the unified catalog resolver', async () => {
    const expected = {
      terminalRuntime: {
        launch: vi.fn(),
      },
      externalSession: null,
      attach: null,
      handoff: null,
      fork: null,
      checkpoint: null,
    };
    resolveBackendExecutionSurfacesMock.mockResolvedValue(expected);

    const bridge = new SessionHostBridge();

    await expect(bridge.resolveExecutionSurfaces('acme.sample.backend')).resolves.toBe(expected);
    expect(resolveBackendExecutionSurfacesMock).toHaveBeenCalledWith('acme.sample.backend');
  });

  it('creates a canonical host session plan through runtimeCore for the requested backend', async () => {
    const createdPlan = {
      kind: 'hostSessionRuntimePlan',
      providerId: 'acme.sample.backend',
      opts: { marker: 'created-plan' },
      config: {},
    };
    const createSessionRuntime = vi.fn(async (_params: unknown) => createdPlan);
    resolveBackendEngineAdapterResolutionMock.mockResolvedValue({
      provenance: 'first_party',
      diagnostics: [],
      engineAdapter: {
        runtimeCore: {
          createSessionRuntime,
        },
      },
    });

    const bridge = new SessionHostBridge();

    await expect(bridge.createSessionRuntime('acme.sample.backend', { cwd: '/tmp/session' })).resolves.toEqual(createdPlan);
    expect(resolveBackendEngineAdapterResolutionMock).toHaveBeenCalledWith('acme.sample.backend', undefined);
    expect(createSessionRuntime).toHaveBeenCalledWith({ cwd: '/tmp/session' });
  });

  it('wraps host session runtime creation with shared runtime publication fallback from engine resolution', async () => {
    const runtimeOperations = createRuntimeTurnOperations();
    const createPlanRuntime = vi.fn(async () => ({
      operations: runtimeOperations,
      nativeRuntime: runtimeOperations,
    }));
    const createdPlan = {
      kind: 'hostSessionRuntimePlan',
      providerId: 'acme.sample.backend',
      opts: { marker: 'created-plan' },
      config: {
        createSessionRuntime: createPlanRuntime,
      },
    };
    const createSessionRuntime = vi.fn(async (_params: unknown) => createdPlan);
    resolveBackendEngineAdapterResolutionMock.mockResolvedValue({
      backendId: 'acme.sample.backend',
      providerId: 'acme.sample.provider',
      provenance: 'external',
      diagnostics: [],
      backend: {
        id: 'acme.sample.backend',
        providerId: 'acme.sample.provider',
        runtimeKind: 'native',
        capabilities: {
          sessions: { supported: true },
        },
      },
      provider: {
        id: 'acme.sample.provider',
      },
      engineAdapter: {
        runtimeCore: {
          createSessionRuntime,
        },
        facets: {
          transcriptSource: {
            page: vi.fn(async () => ({
              items: [],
              nextCursor: null,
              tailCursor: null,
              hasMore: false,
              truncated: false,
            })),
            readAfter: vi.fn(async () => ({
              items: [],
              nextCursor: null,
              truncated: false,
            })),
            acquireFollowLease: vi.fn(async () => null),
          },
        },
      },
    });

    const bridge = new SessionHostBridge();
    const plan = await bridge.createSessionRuntime('acme.sample.backend', { cwd: '/tmp/session' });
    const createdRuntime = await plan.config.createSessionRuntime?.({
      directory: '/tmp/session',
      metadata: {},
      machineId: 'machine-1',
      session: {},
      transcriptSession: {},
      messageBuffer: {},
      mcpServers: {},
      permissionHandler: {},
      getPermissionMode: () => 'default',
      setThinking: () => {},
      memoryRecallGuidanceEnabled: false,
    } as never);

    expect(createdRuntime).toBeTruthy();
    if (!createdRuntime) {
      throw new Error('Expected wrapped host session runtime result');
    }

    const messages: unknown[] = [];
    const unsubscribe = createdRuntime.operations.subscribeRuntimeEvents((message) => {
      messages.push(message);
    });

    await createdRuntime.operations.startOrLoadSession();
    unsubscribe();

    expect(messages).toEqual([
      {
        type: 'event',
        name: 'runtime.descriptor',
        payload: {
          v: 1,
          providerId: 'acme.sample.provider',
          provider: {
            backendMode: 'native',
            providerExtra: {
              owner: 'happier',
              schemaId: 'happier.hostSessionRuntimeIdentity',
              v: 1,
              runtimeHandle: {
                backendId: 'acme.sample.backend',
                providerId: 'acme.sample.provider',
                provenance: 'external',
              },
            },
          },
        },
      },
      {
        type: 'event',
        name: 'runtime.capabilities',
        payload: {
          backend: {
            sessions: { supported: true },
          },
        },
      },
      {
        type: 'event',
        name: 'runtime.facets',
        payload: {
          v: 1,
          transcriptSource: {
            supported: true,
            followLeaseSupported: true,
          },
        },
      },
    ]);
  });

  it('passes happyHomeDir into engine resolution for session runtime parity', async () => {
    const createdPlan = {
      kind: 'hostSessionRuntimePlan',
      providerId: 'acme.sample.backend',
      opts: {
        cwd: '/tmp/session',
        happyHomeDir: '/tmp/happy-home',
      },
      config: {},
    };
    const createSessionRuntime = vi.fn(async (_params: unknown) => createdPlan);
    resolveBackendEngineAdapterResolutionMock.mockResolvedValue({
      provenance: 'first_party',
      diagnostics: [],
      engineAdapter: {
        runtimeCore: {
          createSessionRuntime,
        },
      },
    });

    const bridge = new SessionHostBridge();

    await expect(bridge.createSessionRuntime('acme.sample.backend', {
      cwd: '/tmp/session',
      happyHomeDir: '/tmp/happy-home',
    })).resolves.toEqual(createdPlan);
    expect(resolveBackendEngineAdapterResolutionMock).toHaveBeenCalledWith('acme.sample.backend', {
      happyHomeDir: '/tmp/happy-home',
    });
    expect(createSessionRuntime).toHaveBeenCalledWith({
      cwd: '/tmp/session',
      happyHomeDir: '/tmp/happy-home',
    });
  });

  it('rejects raw runtime turn operations as a bridge return shape', async () => {
    const createSessionRuntime = vi.fn(async () => createRuntimeTurnOperations());
    resolveBackendEngineAdapterResolutionMock.mockResolvedValue({
      provenance: 'first_party',
      diagnostics: [],
      engineAdapter: {
        runtimeCore: {
          createSessionRuntime,
        },
      },
    });

    const bridge = new SessionHostBridge();

    await expect(bridge.createSessionRuntime('acme.sample.backend', { cwd: '/tmp/session' })).rejects.toThrow(
      "Backend 'acme.sample.backend' must return HostSessionRuntimePlan from runtimeCore.createSessionRuntime(...)",
    );
  });

  it('runs session commands through the host-owned session plan for the requested backend', async () => {
    const createdPlan = {
      kind: 'hostSessionRuntimePlan',
      providerId: 'acme.sample.backend',
      opts: { cwd: '/tmp/session', resume: 'resume-1' },
      config: {},
    };
    const createSessionRuntime = vi.fn(async () => createdPlan);
    resolveBackendEngineAdapterResolutionMock.mockResolvedValue({
      provenance: 'first_party',
      diagnostics: [],
      engineAdapter: {
        runtimeCore: {
          createSessionRuntime,
        },
      },
    });

    const bridge = new SessionHostBridge();

    await expect(bridge.runSessionCommand('acme.sample.backend', { cwd: '/tmp/session', resume: 'resume-1' })).resolves.toBeUndefined();
    expect(resolveBackendEngineAdapterResolutionMock).toHaveBeenCalledWith('acme.sample.backend', undefined);
    expect(createSessionRuntime).toHaveBeenCalledWith({ cwd: '/tmp/session', resume: 'resume-1' });
    expect(runHostSessionRuntimePlanMock).toHaveBeenCalledWith(createdPlan);
  });
});
