import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentMessage } from '@/agent/core/AgentMessage';
import type {
  ExecutionRunHostRuntime,
  ExecutionRunHostRuntimeMessageHandler,
  ExecutionRunPermissionCapability,
  RuntimePermissionResponseOutcome,
} from '@/agent/runtime/bridges/executionRun/executionRunHostRuntime';

const getExecutionRunBackendDescriptorMock = vi.fn();
const resolveBackendEngineAdapterResolutionMock = vi.fn();
const requestExecutionRunConnectedServicesMaterializationMock = vi.fn();
const releaseExecutionRunConnectedServicesMock = vi.fn(async (..._args: unknown[]) => ({ ok: true as const }));

vi.mock('@/agent/executionRuns/registry/executionRunBackendRegistry', () => ({
  getExecutionRunBackendDescriptor: (...args: unknown[]) => getExecutionRunBackendDescriptorMock(...args),
}));

vi.mock('@/agent/runtime/registry/engineRegistry', () => ({
  resolveBackendEngineAdapterResolution: (...args: unknown[]) => resolveBackendEngineAdapterResolutionMock(...args),
}));

// The daemon control HTTP bridge is the runner's process boundary for connected-services
// materialization; tests exercise the real helper + create.ts merge on top of it.
vi.mock('@/daemon/controlClient', () => ({
  requestExecutionRunConnectedServicesMaterialization: (...args: unknown[]) =>
    requestExecutionRunConnectedServicesMaterializationMock(...args),
  releaseExecutionRunConnectedServices: (...args: unknown[]) =>
    releaseExecutionRunConnectedServicesMock(...args),
}));

function createStubRuntimeCoreBackend(opts?: Readonly<{
  permissionCapability?: ExecutionRunPermissionCapability;
  dynamicPermissionCapability?: ExecutionRunPermissionCapability;
  runtimeDescriptor?: unknown;
  runtimeCapabilities?: unknown;
  runtimeFacets?: unknown;
}>): ExecutionRunHostRuntime & {
  readonly calls: Readonly<{
    provisionSession: ReturnType<typeof vi.fn>;
    sendPrompt: ReturnType<typeof vi.fn>;
    cancel: ReturnType<typeof vi.fn>;
    subscribeMessages: ReturnType<typeof vi.fn>;
    respondToPermission: ReturnType<typeof vi.fn>;
    waitForTurnCompletion: ReturnType<typeof vi.fn>;
    readResumeSupport: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
  }>;
} {
  let messageHandler: ExecutionRunHostRuntimeMessageHandler | null = null;
  let emittedRuntimeEvents = false;
  let provisioned = false;
  const calls = {
    readResumeSupport: vi.fn(async () => false),
    provisionSession: vi.fn(async () => {
      provisioned = true;
      if (!emittedRuntimeEvents) {
        if (opts?.runtimeDescriptor !== undefined) {
          messageHandler?.({ type: 'event', name: 'runtime.descriptor', payload: opts.runtimeDescriptor });
        }
        if (opts?.runtimeCapabilities !== undefined) {
          messageHandler?.({ type: 'event', name: 'runtime.capabilities', payload: opts.runtimeCapabilities });
        }
        if (opts?.runtimeFacets !== undefined) {
          messageHandler?.({ type: 'event', name: 'runtime.facets', payload: opts.runtimeFacets });
        }
        emittedRuntimeEvents = true;
      }
      return { sessionId: 'plugin-session-1' };
    }),
    sendPrompt: vi.fn(async (_sessionId: string, prompt: string) => {
      messageHandler?.({ type: 'model-output', fullText: `plugin:${prompt}` });
    }),
    cancel: vi.fn(async () => undefined),
    subscribeMessages: vi.fn((handler: ExecutionRunHostRuntimeMessageHandler) => {
      messageHandler = handler;
      return () => {
        if (messageHandler === handler) {
          messageHandler = null;
        }
      };
    }),
    respondToPermission: vi.fn(async () => ({ delivered: true as const })),
    waitForTurnCompletion: vi.fn(async () => undefined),
    dispose: vi.fn(async () => undefined),
  };

  return {
    readResumeSupport: calls.readResumeSupport,
    provisionSession: calls.provisionSession,
    sendPrompt: calls.sendPrompt,
    cancel: calls.cancel,
    subscribeMessages: calls.subscribeMessages,
    waitForTurnCompletion: calls.waitForTurnCompletion,
    dispose: calls.dispose,
    get permissionCapability() {
      return opts?.dynamicPermissionCapability
        ? provisioned ? opts.dynamicPermissionCapability : undefined
        : opts?.permissionCapability;
    },
    get respondToPermission() {
      if (opts?.dynamicPermissionCapability) {
        return provisioned && opts.dynamicPermissionCapability === 'responds'
          ? calls.respondToPermission
          : undefined;
      }
      return opts?.permissionCapability === 'responds'
        ? calls.respondToPermission
        : undefined;
    },
    calls,
  };
}

function expectGenericPluginRuntimeDescriptor() {
  return expect.objectContaining({
    v: 1,
    agentId: 'acme.sample.provider',
    agent: expect.objectContaining({
      backendMode: 'native',
      agentExtra: expect.objectContaining({
        owner: 'happier',
        schemaId: 'happier.pluginRuntimeDescriptorExtra',
        v: 1,
        runtimeHandle: expect.objectContaining({
          backendId: 'acme.sample.backend',
          agentId: 'acme.sample.provider',
          provenance: 'external',
          source: { kind: 'path' },
        }),
      }),
    }),
  });
}

function expectExecutionRunFallbackRuntimeDescriptor() {
  return expect.objectContaining({
    v: 1,
    agentId: 'acme.sample.provider',
    agent: expect.objectContaining({
      backendMode: 'native',
      agentExtra: expect.objectContaining({
        owner: 'happier',
        schemaId: 'happier.executionRunRuntimeIdentity',
        v: 1,
        runtimeHandle: expect.objectContaining({
          backendId: 'acme.sample.backend',
          agentId: 'acme.sample.provider',
          provenance: 'external',
        }),
      }),
    }),
  });
}

describe('createExecutionRunBackend (plugin runtimeCore adapter)', () => {
  beforeEach(() => {
    vi.resetModules();
    getExecutionRunBackendDescriptorMock.mockReset();
    resolveBackendEngineAdapterResolutionMock.mockReset();
  });

  it('exposes a host-owned execution-run runtime surface for runtimeCore-backed backends', async () => {
    getExecutionRunBackendDescriptorMock.mockReturnValue(null);
    const runtimeCoreBackend = createStubRuntimeCoreBackend({
      runtimeDescriptor: {
        backendId: 'acme.sample.backend',
        runtimeKind: 'native',
      },
      runtimeCapabilities: {
        executionRun: { supported: true },
      },
      runtimeFacets: {
        v: 1,
        transcriptSource: {
          supported: true,
        },
      },
    });
    const createExecutionRunBackendMock = vi.fn(() => runtimeCoreBackend);
    resolveBackendEngineAdapterResolutionMock.mockResolvedValue({
      backendId: 'acme.sample.backend',
      providerId: 'acme.sample.provider',
      provenance: 'external',
      backend: {
        id: 'acme.sample.backend',
        providerId: 'acme.sample.provider',
        provenance: 'external',
        source: { kind: 'path' },
        runtimeKind: 'native',
        capabilities: { executionRun: true },
      },
      provider: {
        id: 'acme.sample.provider',
        provenance: 'external',
        source: { kind: 'path' },
      },
      engineAdapter: {
        runtimeCore: {
          createExecutionRunBackend: createExecutionRunBackendMock,
        },
      },
      executionSurfaces: {},
      diagnostics: [],
    });

    const runtimeModule = await import('./create');
    const runtimeFactory = (runtimeModule as Record<string, unknown>).createExecutionRunRuntime;
    expect(typeof runtimeFactory).toBe('function');
    if (typeof runtimeFactory !== 'function') return;

    const runtime = runtimeFactory({
      cwd: '/tmp/plugin-backend',
      backendId: 'acme.sample.backend',
      backendTarget: { kind: 'builtInAgent', agentId: 'acme.sample.backend' as never },
      permissionMode: 'read_only',
      modelId: 'sample-model',
      start: {
        intent: 'plan',
        retentionPolicy: 'ephemeral',
      },
    }) as Readonly<{
      provisionSession: (opts?: { initialPrompt?: string; resumeSessionId?: string; captureReplay?: boolean }) => Promise<{ sessionId: string }>;
      sendPrompt: (sessionId: string, prompt: string) => Promise<void>;
      cancel: (sessionId: string) => Promise<void>;
      subscribeMessages: (handler: (message: AgentMessage) => void) => () => void;
      permissionCapability?: ExecutionRunPermissionCapability;
      respondToPermission?: (requestId: string, approved: boolean) => Promise<RuntimePermissionResponseOutcome>;
      waitForTurnCompletion: (timeoutMs?: number | null) => Promise<void>;
      dispose: () => Promise<void>;
    }>;

    const messages: AgentMessage[] = [];
    const unsubscribe = runtime.subscribeMessages((message) => {
      messages.push(message);
    });

    await expect(runtime.provisionSession({ initialPrompt: 'boot' })).resolves.toEqual({ sessionId: 'plugin-session-1' });
    await expect(runtime.sendPrompt('plugin-session-1', 'hello')).resolves.toBeUndefined();
    await expect(runtime.cancel('plugin-session-1')).resolves.toBeUndefined();
    expect(runtime.permissionCapability).toBe('static');
    expect(runtime.respondToPermission).toBeUndefined();
    await expect(runtime.waitForTurnCompletion(500)).resolves.toBeUndefined();
    unsubscribe();
    await expect(runtime.dispose()).resolves.toBeUndefined();

    expect(resolveBackendEngineAdapterResolutionMock).toHaveBeenCalledWith('acme.sample.backend', expect.any(Object));
    expect(createExecutionRunBackendMock).toHaveBeenCalledWith(expect.objectContaining({
      cwd: '/tmp/plugin-backend',
      backendId: 'acme.sample.backend',
      backendTarget: {
        kind: 'backend',
        backendId: 'acme.sample.backend',
        sourceKind: 'built_in',
      },
      modelId: 'sample-model',
      permissionMode: 'read_only',
      start: {
        intent: 'plan',
        retentionPolicy: 'ephemeral',
      },
    }));
    expect(messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'event',
        name: 'runtime.descriptor',
        payload: expectExecutionRunFallbackRuntimeDescriptor(),
      }),
      expect.objectContaining({
        type: 'event',
        name: 'runtime.capabilities',
      }),
      expect.objectContaining({
        type: 'event',
        name: 'runtime.facets',
      }),
      expect.objectContaining({
        type: 'model-output',
        fullText: 'plugin:hello',
      }),
    ]));
  });

  it('creates an execution-run backend from plugin terminal-runtime launch when no built-in descriptor exists', async () => {
    getExecutionRunBackendDescriptorMock.mockReturnValue(null);
    const runtimeCoreBackend = createStubRuntimeCoreBackend({
      runtimeDescriptor: {
        backendId: 'acme.sample.backend',
        runtimeKind: 'native',
      },
      runtimeCapabilities: {
        executionRun: { supported: true },
      },
      runtimeFacets: {
        v: 1,
        transcriptSource: {
          supported: true,
        },
      },
    });
    const createExecutionRunBackendMock = vi.fn(() => runtimeCoreBackend);
    resolveBackendEngineAdapterResolutionMock.mockResolvedValue({
      backendId: 'acme.sample.backend',
      providerId: 'acme.sample.provider',
      provenance: 'external',
      backend: {
        id: 'acme.sample.backend',
        providerId: 'acme.sample.provider',
        provenance: 'external',
        source: { kind: 'path' },
        runtimeKind: 'native',
        capabilities: { executionRun: true },
      },
      provider: {
        id: 'acme.sample.provider',
        provenance: 'external',
        source: { kind: 'path' },
      },
      engineAdapter: {
        runtimeCore: {
          createExecutionRunBackend: createExecutionRunBackendMock,
        },
      },
      executionSurfaces: {},
      diagnostics: [],
    });

    const { createExecutionRunRuntime } = await import('./create');
    const runtime = createExecutionRunRuntime({
      cwd: '/tmp/plugin-backend',
      backendId: 'acme.sample.backend',
      backendTarget: { kind: 'builtInAgent', agentId: 'acme.sample.backend' as never },
      permissionMode: 'read_only',
      modelId: 'sample-model',
      start: {
        intent: 'plan',
        retentionPolicy: 'ephemeral',
      },
    });

    const messages: AgentMessage[] = [];
    const unsubscribe = runtime.subscribeMessages((message) => {
      messages.push(message);
    });

    await expect(runtime.provisionSession({ initialPrompt: 'boot' })).resolves.toEqual({ sessionId: 'plugin-session-1' });
    await expect(runtime.sendPrompt('plugin-session-1', 'hello')).resolves.toBeUndefined();
    await expect(runtime.cancel('plugin-session-1')).resolves.toBeUndefined();
    expect(runtime.respondToPermission).toBeUndefined();
    await expect(runtime.waitForTurnCompletion?.(500)).resolves.toBeUndefined();
    unsubscribe();
    await expect(runtime.dispose()).resolves.toBeUndefined();

    expect(resolveBackendEngineAdapterResolutionMock).toHaveBeenCalledWith('acme.sample.backend', expect.any(Object));
    expect(createExecutionRunBackendMock).toHaveBeenCalledWith(expect.objectContaining({
      cwd: '/tmp/plugin-backend',
      backendId: 'acme.sample.backend',
      backendTarget: {
        kind: 'backend',
        backendId: 'acme.sample.backend',
        sourceKind: 'built_in',
      },
      modelId: 'sample-model',
      permissionMode: 'read_only',
      start: {
        intent: 'plan',
        retentionPolicy: 'ephemeral',
      },
    }));
    expect(getExecutionRunBackendDescriptorMock).not.toHaveBeenCalled();
    expect(runtimeCoreBackend.calls.provisionSession).toHaveBeenCalledWith({ initialPrompt: 'boot' });
    expect(runtimeCoreBackend.calls.sendPrompt).toHaveBeenCalledWith('plugin-session-1', 'hello', undefined);
    expect(messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'event',
        name: 'runtime.descriptor',
        payload: expectExecutionRunFallbackRuntimeDescriptor(),
      }),
      expect.objectContaining({
        type: 'event',
        name: 'runtime.capabilities',
        payload: {
          executionRun: { supported: true },
        },
      }),
      expect.objectContaining({
        type: 'event',
        name: 'runtime.facets',
        payload: {
          v: 1,
          transcriptSource: {
            supported: true,
          },
        },
      }),
      expect.objectContaining({
        type: 'model-output',
        fullText: 'plugin:hello',
      }),
    ]));
  });

  it('passes generic isolation env to plugin runtimeCore-backed execution runs', async () => {
    getExecutionRunBackendDescriptorMock.mockReturnValue(null);
    const runtimeCoreBackend = createStubRuntimeCoreBackend();
    const createExecutionRunBackendMock = vi.fn(() => runtimeCoreBackend);
    resolveBackendEngineAdapterResolutionMock.mockResolvedValue({
      backendId: 'acme.sample.backend',
      providerId: 'acme.sample.provider',
      provenance: 'external',
      runtimeOwner: {
        backendId: 'acme.sample.backend',
        selected: {
          kind: 'plugin_engine',
          ownerId: 'acme.sample.plugin',
          provenance: 'external',
          pluginId: 'acme.sample.plugin',
        },
        candidates: [{
          kind: 'plugin_engine',
          ownerId: 'acme.sample.plugin',
          provenance: 'external',
          pluginId: 'acme.sample.plugin',
        }],
      },
      backend: {
        id: 'acme.sample.backend',
        providerId: 'acme.sample.provider',
        provenance: 'external',
        source: { kind: 'path' },
        runtimeKind: 'native',
        capabilities: { executionRun: true },
      },
      provider: {
        id: 'acme.sample.provider',
        provenance: 'external',
        source: { kind: 'path' },
      },
      engineAdapter: {
        runtimeCore: {
          createExecutionRunBackend: createExecutionRunBackendMock,
        },
      },
      executionSurfaces: {},
      diagnostics: [],
    });

    const { createExecutionRunRuntime } = await import('./create');
    const runtime = createExecutionRunRuntime({
      cwd: '/tmp/plugin-backend',
      backendId: 'acme.sample.backend',
      backendTarget: { kind: 'builtInAgent', agentId: 'acme.sample.backend' as never },
      permissionMode: 'read_only',
      runId: 'run_isolated',
    });

    await expect(runtime.provisionSession()).resolves.toEqual({ sessionId: 'plugin-session-1' });
    await expect(runtime.dispose()).resolves.toBeUndefined();

    expect(createExecutionRunBackendMock).toHaveBeenCalledWith(expect.objectContaining({
      isolation: {
        env: expect.objectContaining({
          XDG_STATE_HOME: expect.stringContaining('/isolation/acme.sample.backend/execution_run/run_isolated/xdg/state'),
          XDG_CACHE_HOME: expect.stringContaining('/isolation/acme.sample.backend/execution_run/run_isolated/xdg/cache'),
          XDG_DATA_HOME: expect.stringContaining('/isolation/acme.sample.backend/execution_run/run_isolated/xdg/data'),
        }),
      },
    }));
  });

  it('preserves dynamic permission capability through plugin runtime wrappers', async () => {
    getExecutionRunBackendDescriptorMock.mockReturnValue(null);
    const runtimeCoreBackend = createStubRuntimeCoreBackend({
      dynamicPermissionCapability: 'responds',
    });
    const createExecutionRunBackendMock = vi.fn(() => runtimeCoreBackend);
    resolveBackendEngineAdapterResolutionMock.mockResolvedValue({
      backendId: 'acme.sample.backend',
      providerId: 'acme.sample.provider',
      provenance: 'external',
      runtimeOwner: {
        backendId: 'acme.sample.backend',
        selected: {
          kind: 'plugin_engine',
          ownerId: 'acme.sample.plugin',
          provenance: 'external',
          pluginId: 'acme.sample.plugin',
        },
        candidates: [{
          kind: 'plugin_engine',
          ownerId: 'acme.sample.plugin',
          provenance: 'external',
          pluginId: 'acme.sample.plugin',
        }],
      },
      backend: {
        id: 'acme.sample.backend',
        providerId: 'acme.sample.provider',
        provenance: 'external',
        source: { kind: 'path' },
        runtimeKind: 'native',
        capabilities: { executionRun: true },
      },
      provider: {
        id: 'acme.sample.provider',
        provenance: 'external',
        source: { kind: 'path' },
      },
      engineAdapter: {
        runtimeCore: {
          createExecutionRunBackend: createExecutionRunBackendMock,
        },
      },
      executionSurfaces: {},
      diagnostics: [],
    });

    const { createExecutionRunRuntime } = await import('./create');
    const runtime = createExecutionRunRuntime({
      cwd: '/tmp/plugin-backend',
      backendId: 'acme.sample.backend',
      backendTarget: { kind: 'builtInAgent', agentId: 'acme.sample.backend' as never },
      permissionMode: 'read_only',
      runId: 'run_dynamic_permission',
    });

    expect(runtime.respondToPermission).toBeUndefined();
    await expect(runtime.provisionSession()).resolves.toEqual({ sessionId: 'plugin-session-1' });
    expect(runtime.respondToPermission).toBeTypeOf('function');
    await expect(runtime.respondToPermission?.('permission-1', true)).resolves.toEqual({ delivered: true });

    expect(runtimeCoreBackend.calls.respondToPermission).toHaveBeenCalledWith('permission-1', true);
  });

  it('preserves emitted runtime descriptors and fills missing runtime capabilities centrally', async () => {
    getExecutionRunBackendDescriptorMock.mockReturnValue(null);
    const runtimeCoreBackend = createStubRuntimeCoreBackend({
	      runtimeDescriptor: {
	        v: 1,
	        agentId: 'acme.sample.provider',
	        agent: {
	          backendMode: 'native',
	          agentExtra: {
	            owner: 'happier',
	            schemaId: 'happier.pluginRuntimeDescriptorExtra',
	            v: 1,
	            runtimeHandle: {
	              backendId: 'acme.sample.backend',
	              agentId: 'acme.sample.provider',
	              provenance: 'external',
	              source: { kind: 'path' },
	            },
	          },
	        },
	      },
	    });
	    const createExecutionRunBackendMock = vi.fn(() => runtimeCoreBackend);
	    resolveBackendEngineAdapterResolutionMock.mockResolvedValue({
	      backendId: 'acme.sample.backend',
	      providerId: 'acme.sample.provider',
	      provenance: 'external',
	      backend: {
	        id: 'acme.sample.backend',
	        providerId: 'acme.sample.provider',
	        provenance: 'external',
	        source: { kind: 'path' },
	        runtimeKind: 'native',
	        capabilities: { executionRun: true },
	      },
	      provider: {
	        id: 'acme.sample.provider',
	        provenance: 'external',
	        source: { kind: 'path' },
	      },
	      engineAdapter: {
	        runtimeCore: {
	          createExecutionRunBackend: createExecutionRunBackendMock,
	        },
	      },
	      executionSurfaces: {},
	      diagnostics: [],
	    });

    const { createExecutionRunRuntime } = await import('./create');
    const runtime = createExecutionRunRuntime({
      cwd: '/tmp/plugin-backend',
      backendId: 'acme.sample.backend',
      backendTarget: { kind: 'builtInAgent', agentId: 'acme.sample.backend' as never },
      permissionMode: 'read_only',
      modelId: 'sample-model',
      start: {
        intent: 'plan',
        retentionPolicy: 'ephemeral',
      },
    });

    const messages: AgentMessage[] = [];
    const unsubscribe = runtime.subscribeMessages((message) => {
      messages.push(message);
    });

    await expect(runtime.provisionSession({ initialPrompt: 'boot' })).resolves.toEqual({ sessionId: 'plugin-session-1' });
    await expect(runtime.sendPrompt('plugin-session-1', 'hello')).resolves.toBeUndefined();
    unsubscribe();
    await expect(runtime.dispose()).resolves.toBeUndefined();

    expect(createExecutionRunBackendMock).toHaveBeenCalledWith(expect.objectContaining({
      cwd: '/tmp/plugin-backend',
      backendId: 'acme.sample.backend',
      modelId: 'sample-model',
      permissionMode: 'read_only',
      start: {
        intent: 'plan',
        retentionPolicy: 'ephemeral',
      },
    }));
    expect(messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'event',
        name: 'runtime.descriptor',
        payload: expectGenericPluginRuntimeDescriptor(),
      }),
    ]));
    expect(messages.filter((message) => message.type === 'event' && message.name === 'runtime.descriptor')).toHaveLength(1);
    expect(messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'event',
        name: 'runtime.capabilities',
        payload: {
          executionRun: { supported: true },
          backend: { executionRun: true },
        },
      }),
    ]));
  });

  it('fails closed to the generic plugin descriptor when plugin execution-run runtimeDescriptor is malformed', async () => {
    getExecutionRunBackendDescriptorMock.mockReturnValue(null);
	    const runtimeCoreBackend = createStubRuntimeCoreBackend({
	      runtimeDescriptor: {
	        backendId: 'acme.sample.backend',
	        runtimeKind: 'native',
	      },
	    });
	    const createExecutionRunBackendMock = vi.fn(() => runtimeCoreBackend);
	    resolveBackendEngineAdapterResolutionMock.mockResolvedValue({
	      backendId: 'acme.sample.backend',
	      providerId: 'acme.sample.provider',
	      provenance: 'external',
	      backend: {
	        id: 'acme.sample.backend',
	        providerId: 'acme.sample.provider',
	        provenance: 'external',
	        source: { kind: 'path' },
	        runtimeKind: 'native',
	        capabilities: { executionRun: true },
	      },
	      provider: {
	        id: 'acme.sample.provider',
	        provenance: 'external',
	        source: { kind: 'path' },
	      },
	      engineAdapter: {
	        runtimeCore: {
	          createExecutionRunBackend: createExecutionRunBackendMock,
	        },
	      },
	      executionSurfaces: {},
	      diagnostics: [],
	    });

    const { createExecutionRunRuntime } = await import('./create');
    const runtime = createExecutionRunRuntime({
      cwd: '/tmp/plugin-backend',
      backendId: 'acme.sample.backend',
      backendTarget: { kind: 'builtInAgent', agentId: 'acme.sample.backend' as never },
      permissionMode: 'read_only',
      modelId: 'sample-model',
      start: {
        intent: 'plan',
        retentionPolicy: 'ephemeral',
      },
    });

    const messages: AgentMessage[] = [];
    const unsubscribe = runtime.subscribeMessages((message) => {
      messages.push(message);
    });

    await expect(runtime.provisionSession({ initialPrompt: 'boot' })).resolves.toEqual({ sessionId: 'plugin-session-1' });
    unsubscribe();

    expect(messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'event',
        name: 'runtime.descriptor',
        payload: expectExecutionRunFallbackRuntimeDescriptor(),
      }),
    ]));
    expect(messages.filter((message) => message.type === 'event' && message.name === 'runtime.descriptor')).toHaveLength(1);
  });

  it('publishes runtime identity centrally when a runtimeCore-backed backend is silent', async () => {
    getExecutionRunBackendDescriptorMock.mockReturnValue(null);
	    const runtimeCoreBackend = createStubRuntimeCoreBackend();
	    const createExecutionRunBackendMock = vi.fn(() => runtimeCoreBackend);
	    resolveBackendEngineAdapterResolutionMock.mockResolvedValue({
	      backendId: 'acme.sample.backend',
	      providerId: 'acme.sample.provider',
	      provenance: 'external',
	      backend: {
	        id: 'acme.sample.backend',
	        providerId: 'acme.sample.provider',
	        provenance: 'external',
	        source: { kind: 'path' },
	        runtimeKind: 'native',
	        capabilities: { executionRun: true },
	      },
	      provider: {
	        id: 'acme.sample.provider',
	        provenance: 'external',
	        source: { kind: 'path' },
	      },
	      engineAdapter: {
        facets: {
          transcriptSource: {
            supported: true,
          },
        },
	        runtimeCore: {
	          createExecutionRunBackend: createExecutionRunBackendMock,
	        },
	      },
	      executionSurfaces: {},
	      diagnostics: [],
	    });

    const { createExecutionRunRuntime } = await import('./create');
    const runtime = createExecutionRunRuntime({
      cwd: '/tmp/plugin-backend',
      backendId: 'acme.sample.backend',
      backendTarget: { kind: 'builtInAgent', agentId: 'acme.sample.backend' as never },
      permissionMode: 'read_only',
      modelId: 'sample-model',
      start: {
        intent: 'plan',
        retentionPolicy: 'ephemeral',
      },
    });

    const messages: AgentMessage[] = [];
    const unsubscribe = runtime.subscribeMessages((message) => {
      messages.push(message);
    });

    await expect(runtime.provisionSession({ initialPrompt: 'boot' })).resolves.toEqual({ sessionId: 'plugin-session-1' });
    await expect(runtime.sendPrompt('plugin-session-1', 'hello')).resolves.toBeUndefined();
    unsubscribe();

    expect(createExecutionRunBackendMock).toHaveBeenCalledWith(expect.objectContaining({
      cwd: '/tmp/plugin-backend',
      backendId: 'acme.sample.backend',
      modelId: 'sample-model',
      permissionMode: 'read_only',
      start: {
        intent: 'plan',
        retentionPolicy: 'ephemeral',
      },
    }));
    expect(messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'event',
        name: 'runtime.descriptor',
        payload: expectExecutionRunFallbackRuntimeDescriptor(),
      }),
      expect.objectContaining({
        type: 'event',
        name: 'runtime.capabilities',
        payload: {
          executionRun: { supported: true },
          backend: { executionRun: true },
        },
      }),
      expect.objectContaining({
        type: 'event',
        name: 'runtime.facets',
        payload: {
          v: 1,
          transcriptSource: {
            supported: true,
          },
        },
      }),
    ]));
  });

  it('fails closed when plugin execution surfaces do not provide terminal-runtime launch', async () => {
    getExecutionRunBackendDescriptorMock.mockReturnValue(null);
	    const createExecutionRunBackendMock = vi.fn(() => {
	      throw new Error("Execution-run backend 'acme.sample.backend' is missing terminal runtime launch support");
	    });
	    resolveBackendEngineAdapterResolutionMock.mockResolvedValue({
	      backendId: 'acme.sample.backend',
	      providerId: 'acme.sample.provider',
	      provenance: 'external',
	      backend: {
	        id: 'acme.sample.backend',
	        providerId: 'acme.sample.provider',
	        provenance: 'external',
	        source: { kind: 'path' },
	        runtimeKind: 'native',
	        capabilities: { executionRun: true },
	      },
	      provider: {
	        id: 'acme.sample.provider',
	        provenance: 'external',
	        source: { kind: 'path' },
	      },
	      engineAdapter: {
	        runtimeCore: {
	          createExecutionRunBackend: createExecutionRunBackendMock,
	        },
	      },
	      executionSurfaces: {},
	      diagnostics: [],
	    });

    const { createExecutionRunRuntime } = await import('./create');
    const runtime = createExecutionRunRuntime({
      cwd: '/tmp/plugin-backend',
      backendId: 'acme.sample.backend',
      backendTarget: { kind: 'builtInAgent', agentId: 'acme.sample.backend' as never },
      permissionMode: 'read_only',
    });

    await expect(runtime.provisionSession()).rejects.toThrow(/terminal runtime launch/i);
  });

  it('fails with unsupported backend when descriptor fallback resolves a non-plugin engine source', async () => {
    getExecutionRunBackendDescriptorMock.mockReturnValue(null);
    resolveBackendEngineAdapterResolutionMock.mockResolvedValue(null);

    const { createExecutionRunRuntime } = await import('./create');
    const runtime = createExecutionRunRuntime({
      cwd: '/tmp/non-plugin-backend',
      backendId: 'acme.sample.backend',
      permissionMode: 'read_only',
    });

    await expect(runtime.provisionSession()).rejects.toThrow('Unsupported execution-run backend: acme.sample.backend');
  });

  it('does not subscribe late when the caller unsubscribes before runtimeCore resolution finishes', async () => {
    getExecutionRunBackendDescriptorMock.mockReturnValue(null);

    let resolveEngineResolution!: (value: unknown) => void;
    const engineResolutionPromise = new Promise((resolve: (value: unknown) => void) => {
      resolveEngineResolution = resolve;
    });
    resolveBackendEngineAdapterResolutionMock.mockReturnValue(engineResolutionPromise);

    const runtimeCoreBackend = createStubRuntimeCoreBackend();
    const createExecutionRunBackendMock = vi.fn(() => runtimeCoreBackend);

    const runtimeModule = await import('./create');
    const runtimeFactory = (runtimeModule as Record<string, unknown>).createExecutionRunRuntime;
    expect(typeof runtimeFactory).toBe('function');
    if (typeof runtimeFactory !== 'function') return;

    const runtime = runtimeFactory({
      cwd: '/tmp/plugin-backend',
      backendId: 'acme.sample.backend',
      backendTarget: { kind: 'builtInAgent', agentId: 'acme.sample.backend' as never },
      permissionMode: 'read_only',
    }) as Readonly<{
      provisionSession: () => Promise<{ sessionId: string }>;
      subscribeMessages: (handler: (message: AgentMessage) => void) => () => void;
    }>;

    const unsubscribe = runtime.subscribeMessages(() => {});
    unsubscribe();

	    resolveEngineResolution({
	      backendId: 'acme.sample.backend',
	      providerId: 'acme.sample.provider',
	      provenance: 'external',
	      backend: {
	        id: 'acme.sample.backend',
	        providerId: 'acme.sample.provider',
	        provenance: 'external',
	        source: { kind: 'path' },
	        runtimeKind: 'native',
	        capabilities: { executionRun: true },
	      },
	      provider: {
	        id: 'acme.sample.provider',
	        provenance: 'external',
	        source: { kind: 'path' },
	      },
	      engineAdapter: {
	        runtimeCore: {
	          createExecutionRunBackend: createExecutionRunBackendMock,
	        },
	      },
	      executionSurfaces: {},
	      diagnostics: [],
	    });

    await expect(runtime.provisionSession()).resolves.toEqual({ sessionId: 'plugin-session-1' });

    expect(createExecutionRunBackendMock).toHaveBeenCalled();
    expect(runtimeCoreBackend.calls.subscribeMessages).toHaveBeenCalledTimes(1);
  });

  it('fails execution-run startup when plugin trust approval is still required', async () => {
	    getExecutionRunBackendDescriptorMock.mockReturnValue(null);
	    const createExecutionRunBackendMock = vi.fn(() => createStubRuntimeCoreBackend());
	    resolveBackendEngineAdapterResolutionMock.mockResolvedValue({
	      backendId: 'acme.sample.backend',
	      providerId: 'acme.sample.provider',
	      provenance: 'external',
	      backend: {
	        id: 'acme.sample.backend',
	        providerId: 'acme.sample.provider',
	        provenance: 'external',
	        source: { kind: 'path' },
	        runtimeKind: 'native',
	        capabilities: { executionRun: true },
	      },
	      provider: {
	        id: 'acme.sample.provider',
	        provenance: 'external',
	        source: { kind: 'path' },
	      },
	      engineAdapter: {
	        runtimeCore: {
	          createExecutionRunBackend: createExecutionRunBackendMock,
	        },
	      },
      diagnostics: [{
        code: 'engine_plugin_daemon_module_load_failed',
        detailCode: 'plugin_trust_approval_required',
	        message: 'Plugin trust approval is required before this backend can run.',
	      }],
	    });

    const runtimeModule = await import('./create');
    const runtimeFactory = (runtimeModule as Record<string, unknown>).createExecutionRunRuntime;
    expect(typeof runtimeFactory).toBe('function');
    if (typeof runtimeFactory !== 'function') return;

    const runtime = runtimeFactory({
      cwd: '/tmp/plugin-backend',
      backendId: 'acme.sample.backend',
      backendTarget: { kind: 'builtInAgent', agentId: 'acme.sample.backend' as never },
      permissionMode: 'read_only',
    }) as Readonly<{
      provisionSession: () => Promise<{ sessionId: string }>;
    }>;

    await expect(runtime.provisionSession()).rejects.toThrow(
      'Plugin trust approval is required before this backend can run.',
    );
    expect(createExecutionRunBackendMock).not.toHaveBeenCalled();
  });

  it('fails execution-run startup when the plugin runtime source is untrusted', async () => {
	    getExecutionRunBackendDescriptorMock.mockReturnValue(null);
	    const createExecutionRunBackendMock = vi.fn(() => createStubRuntimeCoreBackend());
	    resolveBackendEngineAdapterResolutionMock.mockResolvedValue({
	      backendId: 'acme.sample.backend',
	      providerId: 'acme.sample.provider',
	      provenance: 'external',
	      backend: {
	        id: 'acme.sample.backend',
	        providerId: 'acme.sample.provider',
	        provenance: 'external',
	        source: { kind: 'path' },
	        runtimeKind: 'native',
	        capabilities: { executionRun: true },
	      },
	      provider: {
	        id: 'acme.sample.provider',
	        provenance: 'external',
	        source: { kind: 'path' },
	      },
	      engineAdapter: {
	        runtimeCore: {
	          createExecutionRunBackend: createExecutionRunBackendMock,
	        },
      },
      diagnostics: [{
        code: 'engine_plugin_daemon_module_load_failed',
        detailCode: 'plugin_untrusted',
        message: 'Refusing to load executable plugin daemon entry from an untrusted source.',
      }],
    });

    const runtimeModule = await import('./create');
    const runtimeFactory = (runtimeModule as Record<string, unknown>).createExecutionRunRuntime;
    expect(typeof runtimeFactory).toBe('function');
    if (typeof runtimeFactory !== 'function') return;

    const runtime = runtimeFactory({
      cwd: '/tmp/plugin-backend',
      backendId: 'acme.sample.backend',
      backendTarget: { kind: 'builtInAgent', agentId: 'acme.sample.backend' as never },
      permissionMode: 'read_only',
    }) as Readonly<{
      provisionSession: () => Promise<{ sessionId: string }>;
    }>;

    await expect(runtime.provisionSession()).rejects.toThrow(
      'Refusing to load executable plugin daemon entry from an untrusted source.',
    );
    expect(createExecutionRunBackendMock).not.toHaveBeenCalled();
  });

  it('merges daemon-materialized connected-services env into the backend isolation env', async () => {
    getExecutionRunBackendDescriptorMock.mockReturnValue(null);
    requestExecutionRunConnectedServicesMaterializationMock.mockResolvedValue({
      ok: true,
      result: {
        env: { CODEX_HOME: '/materialized/run_cs_1/codex-home' },
        connectedServicesBindings: {
          v: 1,
          bindingsByServiceId: {
            'openai-codex': { source: 'connected', selection: 'profile', profileId: 'profile_1' },
          },
        },
      },
    });
    const runtimeCoreBackend = createStubRuntimeCoreBackend();
    const createExecutionRunBackendMock = vi.fn(() => runtimeCoreBackend);
    resolveBackendEngineAdapterResolutionMock.mockResolvedValue({
      backendId: 'codex',
      providerId: 'codex',
      provenance: 'built_in',
      backend: {
        id: 'codex',
        providerId: 'codex',
        provenance: 'built_in',
        source: { kind: 'built_in' },
        runtimeKind: 'acp',
        capabilities: { executionRun: true },
      },
      provider: {
        id: 'codex',
        provenance: 'built_in',
        source: { kind: 'built_in' },
      },
      engineAdapter: {
        runtimeCore: {
          createExecutionRunBackend: createExecutionRunBackendMock,
        },
      },
      executionSurfaces: {},
      diagnostics: [],
    });

    const runtimeModule = await import('./create');
    const runtime = runtimeModule.createExecutionRunRuntime({
      cwd: '/tmp/project',
      runId: 'run_cs_1',
      backendId: 'codex',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      permissionMode: 'default',
      connectedServices: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': { source: 'connected', selection: 'profile', profileId: 'profile_1' },
        },
      },
    });

    await runtime.provisionSession();

    expect(requestExecutionRunConnectedServicesMaterializationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run_cs_1',
        agentId: 'codex',
        cwd: '/tmp/project',
      }),
    );
    expect(createExecutionRunBackendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        isolation: expect.objectContaining({
          env: expect.objectContaining({
            CODEX_HOME: '/materialized/run_cs_1/codex-home',
          }),
        }),
      }),
    );

    // Run end releases the materialization (unregister + daemon-side cleanup).
    await runtime.dispose();
    expect(releaseExecutionRunConnectedServicesMock).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'run_cs_1' }),
    );
  });

  it('fails closed at backend resolution when the connected-services bridge is unreachable', async () => {
    getExecutionRunBackendDescriptorMock.mockReturnValue(null);
    requestExecutionRunConnectedServicesMaterializationMock.mockResolvedValue({
      error: 'No daemon running, no state file found',
    });
    const createExecutionRunBackendMock = vi.fn(() => createStubRuntimeCoreBackend());
    resolveBackendEngineAdapterResolutionMock.mockResolvedValue({
      backendId: 'codex',
      providerId: 'codex',
      provenance: 'built_in',
      backend: {
        id: 'codex',
        providerId: 'codex',
        provenance: 'built_in',
        source: { kind: 'built_in' },
        runtimeKind: 'acp',
        capabilities: { executionRun: true },
      },
      provider: {
        id: 'codex',
        provenance: 'built_in',
        source: { kind: 'built_in' },
      },
      engineAdapter: {
        runtimeCore: {
          createExecutionRunBackend: createExecutionRunBackendMock,
        },
      },
      executionSurfaces: {},
      diagnostics: [],
    });

    const runtimeModule = await import('./create');
    const runtime = runtimeModule.createExecutionRunRuntime({
      cwd: '/tmp/project',
      runId: 'run_cs_2',
      backendId: 'codex',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      permissionMode: 'default',
      connectedServices: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': { source: 'connected', selection: 'profile', profileId: 'profile_1' },
        },
      },
    });

    await expect(runtime.provisionSession()).rejects.toThrow('No daemon running');
    expect(createExecutionRunBackendMock).not.toHaveBeenCalled();
  });
});
