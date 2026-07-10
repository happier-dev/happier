import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readHookEventEnvelopeV1 } from '@happier-dev/protocol';
import type { BackendSurfaceDeclarationV1 } from '@happier-dev/protocol';

import { createResolvedContributionRegistry } from '../../../plugins/projection/registry/createResolvedContributionRegistry';
import { ExternalSessionProviderFailureError } from '@/session/external/providerOps';
import type {
  ResolvedAgentRuntimeContribution,
  ResolvedAgentContribution,
} from '../../../plugins/projection/registry/types';
import type { ResolvedExecutablePluginRuntimeRegistry } from '../../../plugins/runtime/resolveExecutablePluginRuntimeRegistry';

const { loadPluginDaemonModuleMock } = vi.hoisted(() => ({
  loadPluginDaemonModuleMock: vi.fn(),
}));

vi.mock('../../../plugins/runtime/loadPluginDaemonModule', () => ({
  loadPluginDaemonModule: loadPluginDaemonModuleMock,
}));

import { resolvePluginBackendSurfaceHandlers } from './resolvePluginBackendSurfaceHandlers';
import type { BackendExecutionSurfaces } from './engineRegistryTypes';

function createProviderContribution(): ResolvedAgentContribution {
    return {
        id: 'acme.runtime',
        provenance: 'external',
        source: { kind: 'path' },
        definition: {
            kindVersion: 1,
            id: 'acme.runtime',
            ownedBackendIds: ['acme.runtime.backend'],
        },
    };
}

function createBackendContribution(): ResolvedAgentRuntimeContribution {
    return {
        id: 'acme.runtime.backend',
        agentId: 'acme.runtime',
        provenance: 'external',
        source: { kind: 'path' },
        definition: {
            kindVersion: 1,
            id: 'acme.runtime.backend',
            agentId: 'acme.runtime',
        },
        runtimeKind: 'acp',
        daemonEntryPath: '/tmp/acme-runtime/daemon.mjs',
        pluginId: 'acme.runtime',
        manifestPath: '/tmp/acme-runtime/.happier-plugin/plugin.json',
        manifestDigest: 'digest-1',
    };
}

function createRuntimeRegistry(
  backend: ResolvedAgentRuntimeContribution,
  provider: ResolvedAgentContribution = createProviderContribution(),
): ResolvedExecutablePluginRuntimeRegistry {
  const contributions = createResolvedContributionRegistry({
    agents: [provider],
    agentRuntimes: [backend],
    hookRegistrations: [],
  });

    return {
    contributes: contributions,
    activatedPluginIds: new Set(),
    activatePluginsByEvent: async () => [],
    actionHandlersByActionId: new Map(),
    hookHandlersByHookId: new Map(),
    runtimeCoreHandlersByBackendId: new Map(),
    agentRuntimesByAgentId: new Map(),
    scmHostingProvidersById: new Map(),
    networkAllowedUrlOriginsByPluginId: new Map(),
    processSpawnAllowedPathsByPluginId: new Map(),
    pluginDiagnosticsByPluginId: Object.freeze({}),
    addRuntimeDisposable: (_pluginId, disposable) => disposable,
    readHookEventEnvelopeV1,
    dispose: async () => undefined,
  };
}

const rawSession = Object.freeze({}) as Parameters<NonNullable<NonNullable<BackendExecutionSurfaces['externalSession']>['resolveTakeoverSpawnOptions']>>[0]['linked']['rawSession'];

function createLinkedSession(
  overrides: Partial<Parameters<NonNullable<NonNullable<BackendExecutionSurfaces['externalSession']>['resolveTakeoverSpawnOptions']>>[0]['linked']> = {},
): Parameters<NonNullable<NonNullable<BackendExecutionSurfaces['externalSession']>['resolveTakeoverSpawnOptions']>>[0]['linked'] {
  return {
    rawSession,
    metadata: { path: '/repo/from-metadata' },
    sessionPath: '/repo/from-session-path',
    agentId: 'claude',
    machineId: 'machine-1',
    remoteSessionId: 'provider-session-1',
    source: { kind: 'claudeConfig', configDir: '/tmp/.claude', projectId: 'project-1' },
    codexBackendMode: null,
    ...overrides,
  };
}

describe('resolvePluginBackendSurfaceHandlers', () => {
  beforeEach(() => {
    loadPluginDaemonModuleMock.mockReset();
  });

  it('resolves daemon-backed backend surface handlers into the canonical execution surfaces', async () => {
    const backend = createBackendContribution();
    const provider = createProviderContribution();
    const surfaceHandler: BackendSurfaceDeclarationV1 = {
      surfaceApiVersion: 1,
      id: 'backend.terminalRuntime.launch',
      kind: 'terminalRuntime',
      operation: 'launch',
      support: 'supported',
      handler: {
        target: 'daemon',
        exportName: 'launch',
      },
    };
    const backendWithSurfaceHandlers: ResolvedAgentRuntimeContribution = {
      ...backend,
      surfaceHandlers: [surfaceHandler],
    };
    const launch = vi.fn(async () => 'launched');
    loadPluginDaemonModuleMock.mockResolvedValue({
      launch,
    });

    const result = await resolvePluginBackendSurfaceHandlers({
      backend: backendWithSurfaceHandlers,
      provider,
      runtimeRegistry: createRuntimeRegistry(backendWithSurfaceHandlers, provider),
    });

    expect('bindings' in result).toBe(false);
    expect(result.diagnostics).toEqual([]);
    await expect(result.surfaces.terminalRuntime?.launch?.({})).resolves.toBe('launched');
    const surfaceRecord = result.surfaces as unknown as Record<string, unknown>;
    expect(surfaceRecord.externalSessions).toBeUndefined();
    expect(surfaceRecord.sessionHandoff).toBeUndefined();
    expect(result.surfaces.externalSession).toBeNull();
    expect(result.surfaces.attach).toBeNull();
    expect(result.surfaces.handoff).toBeNull();
    expect(result.surfaces.fork).toBeNull();
    expect(result.surfaces.checkpoint).toBeNull();
    expect(loadPluginDaemonModuleMock).toHaveBeenCalledWith({
      daemonEntryPath: '/tmp/acme-runtime/daemon.mjs',
      cacheKey: 'digest-1',
    });
  });

  it('materializes fork and checkpoint handlers into final backend execution surfaces', async () => {
    const backend = createBackendContribution();
    const provider = createProviderContribution();
    const surfaceHandlers: BackendSurfaceDeclarationV1[] = [
      {
        surfaceApiVersion: 1,
        id: 'backend.fork.fork',
        kind: 'fork',
        operation: 'fork',
        support: 'supported',
        handler: {
          target: 'daemon',
          exportName: 'fork',
        },
      },
      {
        surfaceApiVersion: 1,
        id: 'backend.checkpoint.restore',
        kind: 'checkpoint',
        operation: 'restore',
        support: 'supported',
        handler: {
          target: 'daemon',
          exportName: 'restore',
        },
      },
    ];
    const backendWithSurfaceHandlers: ResolvedAgentRuntimeContribution = {
      ...backend,
      surfaceHandlers,
    };
    const fork = vi.fn(async () => ({
      providerSessionId: 'vendor-child-1',
      launch: {
        directory: '/repo',
        sessionStateUpdates: [
          {
            fieldId: 'identity.providerSessionId',
            value: 'vendor-child-1',
          },
        ],
      },
    }));
    const restore = vi.fn(async () => ({ ok: true }));
    loadPluginDaemonModuleMock.mockResolvedValue({
      fork,
      restore,
    });

    const result = await resolvePluginBackendSurfaceHandlers({
      backend: backendWithSurfaceHandlers,
      provider,
      runtimeRegistry: createRuntimeRegistry(backendWithSurfaceHandlers, provider),
    });

    expect(result.diagnostics).toEqual([]);
    const forkRequest = {
      parentSessionId: 'session-1',
      parentMetadata: {},
      directory: '/repo',
      forkPoint: { kind: 'latest' as const },
    };
    await expect(result.surfaces.fork?.fork?.(forkRequest)).resolves.toEqual({
      providerSessionId: 'vendor-child-1',
      launch: {
        directory: '/repo',
        sessionStateUpdates: [
          {
            fieldId: 'identity.providerSessionId',
            value: 'vendor-child-1',
          },
        ],
      },
    });
    expect(fork).toHaveBeenCalledWith(forkRequest);
    await expect(result.surfaces.checkpoint?.restore?.({
      sessionId: 'session-1',
      target: { kind: 'provider_checkpoint', checkpointId: 'checkpoint-1' },
      scopes: ['conversation'],
    })).resolves.toEqual({ ok: true });
  });

  it('materializes daemon availability handlers and maps thrown evaluators fail closed', async () => {
    const backend = createBackendContribution();
    const provider = createProviderContribution();
    const surfaceHandlers: BackendSurfaceDeclarationV1[] = [
      {
        surfaceApiVersion: 1,
        id: 'backend.terminalRuntime.evaluateAvailability',
        kind: 'terminalRuntime',
        operation: 'evaluateAvailability',
        support: 'supported',
        handler: {
          target: 'daemon',
          exportName: 'terminalAvailability',
        },
      },
      {
        surfaceApiVersion: 1,
        id: 'backend.externalSession.evaluateAvailability',
        kind: 'externalSession',
        operation: 'evaluateAvailability',
        support: 'supported',
        handler: {
          target: 'daemon',
          exportName: 'externalAvailability',
        },
      },
      {
        surfaceApiVersion: 1,
        id: 'backend.handoff.evaluateAvailability',
        kind: 'handoff',
        operation: 'evaluateAvailability',
        support: 'supported',
        handler: {
          target: 'daemon',
          exportName: 'handoffAvailability',
        },
      },
      {
        surfaceApiVersion: 1,
        id: 'backend.handoff.exportBundle',
        kind: 'handoff',
        operation: 'exportBundle',
        support: 'supported',
        handler: {
          target: 'daemon',
          exportName: 'exportBundle',
        },
      },
      {
        surfaceApiVersion: 1,
        id: 'backend.handoff.importBundle',
        kind: 'handoff',
        operation: 'importBundle',
        support: 'supported',
        handler: {
          target: 'daemon',
          exportName: 'importBundle',
        },
      },
      {
        surfaceApiVersion: 1,
        id: 'backend.fork.evaluateAvailability',
        kind: 'fork',
        operation: 'evaluateAvailability',
        support: 'supported',
        handler: {
          target: 'daemon',
          exportName: 'forkAvailability',
        },
      },
      {
        surfaceApiVersion: 1,
        id: 'backend.checkpoint.evaluateAvailability',
        kind: 'checkpoint',
        operation: 'evaluateAvailability',
        support: 'supported',
        handler: {
          target: 'daemon',
          exportName: 'checkpointAvailability',
        },
      },
    ];
    const backendWithSurfaceHandlers: ResolvedAgentRuntimeContribution = {
      ...backend,
      surfaceHandlers,
    };
    const throwAvailability = vi.fn(async () => {
      throw new Error('provider exploded');
    });
    loadPluginDaemonModuleMock.mockResolvedValue({
      terminalAvailability: throwAvailability,
      externalAvailability: throwAvailability,
      handoffAvailability: throwAvailability,
      forkAvailability: throwAvailability,
      checkpointAvailability: throwAvailability,
      exportBundle: vi.fn(async () => ({ ok: true, value: { bundle: {} } })),
      importBundle: vi.fn(async () => ({ ok: true, value: { providerSessionId: 'vendor-1', launch: {} } })),
    });

    const result = await resolvePluginBackendSurfaceHandlers({
      backend: backendWithSurfaceHandlers,
      provider,
      runtimeRegistry: createRuntimeRegistry(backendWithSurfaceHandlers, provider),
    });

    expect(result.diagnostics).toEqual([]);
    await expect(result.surfaces.terminalRuntime?.evaluateAvailability?.({
      operation: 'launch',
      sessionId: 'session-1',
      metadata: {},
      directory: '/repo',
    })).resolves.toEqual({ available: false, reasonCode: 'evaluation_error' });
    await expect(result.surfaces.externalSession?.evaluateAvailability?.({
      operation: 'resolveSource',
      source: { kind: 'codexHome', home: 'user' },
    })).resolves.toEqual({ available: false, reasonCode: 'evaluation_error' });
    await expect(result.surfaces.handoff?.evaluateAvailability?.({
      operation: 'exportBundle',
      sessionId: 'session-1',
      metadata: {},
    })).resolves.toEqual({ available: false, reasonCode: 'evaluation_error' });
    await expect(result.surfaces.fork?.evaluateAvailability?.({
      operation: 'fork',
      parentSessionId: 'session-1',
      parentMetadata: {},
      directory: '/repo',
      forkPoint: { kind: 'latest' },
    })).resolves.toEqual({ available: false, reasonCode: 'evaluation_error' });
    await expect(result.surfaces.checkpoint?.evaluateAvailability?.({
      operation: 'restore',
      sessionId: 'session-1',
      target: { kind: 'provider_checkpoint', checkpointId: 'checkpoint-1' },
      scopes: ['conversation'],
      timing: 'idle',
    })).resolves.toEqual({ available: false, reasonCode: 'evaluation_error' });
  });

  it('rejects stale checkpoint restore handler requests before daemon dispatch', async () => {
    const backend = createBackendContribution();
    const provider = createProviderContribution();
    const surfaceHandlers: BackendSurfaceDeclarationV1[] = [
      {
        surfaceApiVersion: 1,
        id: 'backend.checkpoint.restore',
        kind: 'checkpoint',
        operation: 'restore',
        support: 'supported',
        handler: {
          target: 'daemon',
          exportName: 'restore',
        },
      },
    ];
    const backendWithSurfaceHandlers: ResolvedAgentRuntimeContribution = {
      ...backend,
      surfaceHandlers,
    };
    const restore = vi.fn(async () => ({ ok: true }));
    loadPluginDaemonModuleMock.mockResolvedValue({ restore });

    const result = await resolvePluginBackendSurfaceHandlers({
      backend: backendWithSurfaceHandlers,
      provider,
      runtimeRegistry: createRuntimeRegistry(backendWithSurfaceHandlers),
    });

    expect(() => result.surfaces.checkpoint?.restore?.({
      sessionId: 'session-1',
      target: {
        kind: 'provider_checkpoint',
        id: 'checkpoint-1',
      },
      scopes: ['conversation'],
    } as never)).toThrow(/checkpointId/i);
    expect(restore).not.toHaveBeenCalled();
  });

  it('rejects malformed checkpoint creation requests before daemon dispatch', async () => {
    const backend = createBackendContribution();
    const provider = createProviderContribution();
    const surfaceHandlers: BackendSurfaceDeclarationV1[] = [
      {
        surfaceApiVersion: 1,
        id: 'backend.checkpoint.checkpoint',
        kind: 'checkpoint',
        operation: 'checkpoint',
        support: 'supported',
        handler: {
          target: 'daemon',
          exportName: 'checkpoint',
        },
      },
    ];
    const backendWithSurfaceHandlers: ResolvedAgentRuntimeContribution = {
      ...backend,
      surfaceHandlers,
    };
    const checkpoint = vi.fn(async () => ({
      id: 'checkpoint-1',
      target: { kind: 'provider_checkpoint', checkpointId: 'checkpoint-1' },
      timing: 'idle',
      checkpointScopes: ['conversation'],
      restoreScopes: ['conversation'],
    }));
    loadPluginDaemonModuleMock.mockResolvedValue({ checkpoint });

    const result = await resolvePluginBackendSurfaceHandlers({
      backend: backendWithSurfaceHandlers,
      provider,
      runtimeRegistry: createRuntimeRegistry(backendWithSurfaceHandlers),
    });

    await expect(async () => result.surfaces.checkpoint?.checkpoint?.({
      sessionId: 'session-1',
      scopes: [],
      timing: 'idle',
    } as never)).rejects.toThrow(/scopes/i);
    expect(checkpoint).not.toHaveBeenCalled();
  });

  it('materializes external-session handlers per operation without requiring optional leaves', async () => {
    const backend = createBackendContribution();
    const provider = createProviderContribution();
    const surfaceHandlers: BackendSurfaceDeclarationV1[] = [
      {
        surfaceApiVersion: 1,
        id: 'backend.externalSession.resolveSource',
        kind: 'externalSession',
        operation: 'resolveSource',
        support: 'supported',
        handler: {
          target: 'daemon',
          exportName: 'resolveSource',
        },
      },
      {
        surfaceApiVersion: 1,
        id: 'backend.externalSession.listCandidates',
        kind: 'externalSession',
        operation: 'listCandidates',
        support: 'supported',
        handler: {
          target: 'daemon',
          exportName: 'listCandidates',
        },
      },
      {
        surfaceApiVersion: 1,
        id: 'backend.externalSession.pageTranscript',
        kind: 'externalSession',
        operation: 'pageTranscript',
        support: 'supported',
        handler: {
          target: 'daemon',
          exportName: 'pageTranscript',
        },
      },
    ];
    const backendWithSurfaceHandlers: ResolvedAgentRuntimeContribution = {
      ...backend,
      surfaceHandlers,
    };
    const resolveSource = vi.fn(async ({ source }) => ({ ok: true as const, value: { source } }));
    const listCandidates = vi.fn(async () => ({ ok: true as const, value: { candidates: [], nextCursor: null } }));
    const pageTranscript = vi.fn(async () => ({
      ok: true as const,
      value: {
        items: [],
        nextCursor: null,
        tailCursor: null,
        hasMore: false,
      },
    }));
    loadPluginDaemonModuleMock.mockResolvedValue({
      resolveSource,
      listCandidates,
      pageTranscript,
    });

    const result = await resolvePluginBackendSurfaceHandlers({
      backend: backendWithSurfaceHandlers,
      provider,
      runtimeRegistry: createRuntimeRegistry(backendWithSurfaceHandlers),
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.surfaces.externalSession).toEqual(expect.objectContaining({
      validateSource: expect.any(Function),
      listCandidates: expect.any(Function),
      pageTranscript: expect.any(Function),
    }));
    expect(result.surfaces.externalSession?.getActivity).toBeUndefined();
    expect(result.surfaces.externalSession?.readAfterTranscript).toBeUndefined();
    expect(result.surfaces.externalSession?.resolveTakeoverSpawnOptions).toBeUndefined();
    const env = { PI_CODING_AGENT_DIR: '/tmp/omp-agent' } as NodeJS.ProcessEnv;
    await expect(result.surfaces.externalSession?.validateSource?.({
      source: { kind: 'codexHome', home: 'user' },
      env,
    })).resolves.toEqual({
      ok: true,
      source: { kind: 'codexHome', home: 'user' },
    });
    expect((resolveSource.mock.calls[0]?.[0] as { env?: NodeJS.ProcessEnv }).env).toBe(env);
    await expect(result.surfaces.externalSession?.listCandidates?.({
      source: { kind: 'codexHome', home: 'user' },
      limit: 10,
    })).resolves.toEqual({ candidates: [], nextCursor: null });
  });

  it('preserves typed provider failures from daemon external-session candidate handlers', async () => {
    const backend = createBackendContribution();
    const provider = createProviderContribution();
    const surfaceHandlers: BackendSurfaceDeclarationV1[] = [
      {
        surfaceApiVersion: 1,
        id: 'backend.externalSession.listCandidates',
        kind: 'externalSession',
        operation: 'listCandidates',
        support: 'supported',
        handler: {
          target: 'daemon',
          exportName: 'listCandidates',
        },
      },
    ];
    const backendWithSurfaceHandlers: ResolvedAgentRuntimeContribution = {
      ...backend,
      surfaceHandlers,
    };
    const listCandidates = vi.fn(async () => ({
      ok: false as const,
      code: 'agent_unavailable' as const,
      message: 'external_session_candidate_service_unavailable',
      retryable: true,
    }));
    loadPluginDaemonModuleMock.mockResolvedValue({
      listCandidates,
    });

    const result = await resolvePluginBackendSurfaceHandlers({
      backend: backendWithSurfaceHandlers,
      provider,
      runtimeRegistry: createRuntimeRegistry(backendWithSurfaceHandlers),
    });

    await expect(result.surfaces.externalSession?.listCandidates?.({
      source: { kind: 'codexHome', home: 'user' },
      limit: 10,
    })).rejects.toMatchObject({
      name: 'ExternalSessionProviderFailureError',
      code: 'agent_unavailable',
      operation: 'externalSession.listCandidates',
      message: 'external_session_candidate_service_unavailable',
      retryable: true,
    } satisfies Partial<ExternalSessionProviderFailureError>);
  });

  it('preserves host direct-session takeover context around manifest launch hints', async () => {
    const provider: ResolvedAgentContribution = {
      ...createProviderContribution(),
      id: 'claude',
      provenance: 'first_party',
      source: { kind: 'bundled' },
      definition: {
        kindVersion: 1,
        id: 'claude',
        ownedBackendIds: ['claude'],
      },
    };
    const surfaceHandler: BackendSurfaceDeclarationV1 = {
      surfaceApiVersion: 1,
      id: 'backend.externalSession.resolveTakeoverLaunch',
      kind: 'externalSession',
      operation: 'resolveTakeoverLaunch',
      support: 'supported',
      handler: {
        target: 'daemon',
        exportName: 'resolveTakeoverLaunch',
      },
    };
    const backendWithSurfaceHandlers: ResolvedAgentRuntimeContribution = {
      ...createBackendContribution(),
      id: 'claude',
      agentId: 'claude',
      provenance: 'first_party',
      source: { kind: 'bundled' },
      definition: {
        kindVersion: 1,
        id: 'claude',
        agentId: 'claude',
      },
      surfaceHandlers: [surfaceHandler],
    };
    const resolveTakeoverLaunch = vi.fn(async () => ({
      ok: true as const,
      value: {
        providerSessionId: 'provider-session-1',
        source: { kind: 'claudeConfig' as const, configDir: '/tmp/.claude', projectId: 'project-1' },
        launch: {
          directory: '/repo/from-provider',
          environmentVariables: { CLAUDE_CONFIG_DIR: '/tmp/.claude' },
        },
      },
    }));
    loadPluginDaemonModuleMock.mockResolvedValue({ resolveTakeoverLaunch });

    const result = await resolvePluginBackendSurfaceHandlers({
      backend: backendWithSurfaceHandlers,
      provider,
      runtimeRegistry: createRuntimeRegistry(backendWithSurfaceHandlers, provider),
    });

    await expect(result.surfaces.externalSession?.resolveTakeoverSpawnOptions?.({
      linked: createLinkedSession(),
      sessionId: 'happy-session-1',
    })).resolves.toEqual({
      directory: '/repo/from-provider',
      backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
      existingSessionId: 'happy-session-1',
      resume: 'provider-session-1',
      approvedNewDirectoryCreation: true,
      transcriptStorage: 'direct',
      environmentVariables: { CLAUDE_CONFIG_DIR: '/tmp/.claude' },
    });
    expect(resolveTakeoverLaunch).toHaveBeenCalledWith({
      linkedSessionId: 'happy-session-1',
      providerSessionId: 'provider-session-1',
      source: { kind: 'claudeConfig', configDir: '/tmp/.claude', projectId: 'project-1' },
      metadata: { path: '/repo/from-metadata' },
    });
  });

  it('maps manifest takeover_not_available results to a null takeover spawn plan', async () => {
    const backend = createBackendContribution();
    const provider = createProviderContribution();
    const surfaceHandler: BackendSurfaceDeclarationV1 = {
      surfaceApiVersion: 1,
      id: 'backend.externalSession.resolveTakeoverLaunch',
      kind: 'externalSession',
      operation: 'resolveTakeoverLaunch',
      support: 'supported',
      handler: {
        target: 'daemon',
        exportName: 'resolveTakeoverLaunch',
      },
    };
    const backendWithSurfaceHandlers: ResolvedAgentRuntimeContribution = {
      ...backend,
      surfaceHandlers: [surfaceHandler],
    };
    loadPluginDaemonModuleMock.mockResolvedValue({
      resolveTakeoverLaunch: async () => ({
        ok: false as const,
        code: 'takeover_not_available' as const,
        message: 'provider has no resumable cwd',
      }),
    });

    const result = await resolvePluginBackendSurfaceHandlers({
      backend: backendWithSurfaceHandlers,
      provider,
      runtimeRegistry: createRuntimeRegistry(backendWithSurfaceHandlers),
    });

    await expect(result.surfaces.externalSession?.resolveTakeoverSpawnOptions?.({
      linked: createLinkedSession(),
      sessionId: 'happy-session-1',
    })).resolves.toBeNull();
  });

  it('reuses activated backend surface handlers from the executable runtime registry', async () => {
    const backend = createBackendContribution();
    const provider = createProviderContribution();
    const surfaceHandler: BackendSurfaceDeclarationV1 = {
      surfaceApiVersion: 1,
      id: 'backend.terminalRuntime.launch',
      kind: 'terminalRuntime',
      operation: 'launch',
      support: 'supported',
      handler: {
        target: 'daemon',
        exportName: 'launch',
      },
    };
    const backendWithSurfaceHandlers: ResolvedAgentRuntimeContribution = {
      ...backend,
      surfaceHandlers: [surfaceHandler],
    };
    const launch = vi.fn(async () => 'activated-launched');
    loadPluginDaemonModuleMock.mockRejectedValue(new Error('direct module load should not be used'));

    const runtimeRegistry: ResolvedExecutablePluginRuntimeRegistry = {
      ...createRuntimeRegistry(backendWithSurfaceHandlers),
      runtimeCoreHandlersByBackendId: new Map([
        [
          backend.id,
          new Map([
            ['terminalRuntime:launch', launch],
          ]),
        ],
      ]),
    };

    const result = await resolvePluginBackendSurfaceHandlers({
      backend: backendWithSurfaceHandlers,
      provider,
      runtimeRegistry,
    });

    expect(result.diagnostics).toEqual([]);
    await expect(result.surfaces.terminalRuntime?.launch?.({})).resolves.toBe('activated-launched');
    expect(loadPluginDaemonModuleMock).not.toHaveBeenCalled();
  });

  it('merges activated backend surface handlers with manifest-backed backend surface operations', async () => {
    const backend = createBackendContribution();
    const provider = createProviderContribution();
    const surfaceHandlers: BackendSurfaceDeclarationV1[] = [
      {
        surfaceApiVersion: 1,
        id: 'backend.terminalRuntime.launch',
        kind: 'terminalRuntime',
        operation: 'launch',
        support: 'supported',
        handler: {
          target: 'daemon',
          exportName: 'launch',
        },
      },
      {
        surfaceApiVersion: 1,
        id: 'backend.terminalRuntime.discoverIdentity',
        kind: 'terminalRuntime',
        operation: 'discoverIdentity',
        support: 'supported',
        handler: {
          target: 'daemon',
          exportName: 'discoverIdentity',
        },
      },
    ];
    const backendWithSurfaceHandlers: ResolvedAgentRuntimeContribution = {
      ...backend,
      surfaceHandlers,
    };
    const launch = vi.fn(async () => 'activated-launched');
    const resolveTranscriptBinding = vi.fn(async () => 'activated-bind');
    const runtimeRegistry: ResolvedExecutablePluginRuntimeRegistry = {
      ...createRuntimeRegistry(backendWithSurfaceHandlers),
      runtimeCoreHandlersByBackendId: new Map([
        [
          backend.id,
          new Map([
            ['terminalRuntime:resolveTranscriptBinding', resolveTranscriptBinding],
          ]),
        ],
      ]),
    };
    loadPluginDaemonModuleMock.mockResolvedValue({
      launch,
      discoverIdentity: vi.fn(async () => 'manifest-discover-identity'),
    });

    const result = await resolvePluginBackendSurfaceHandlers({
      backend: backendWithSurfaceHandlers,
      provider,
      runtimeRegistry,
    });

    const terminalRuntime = result.surfaces.terminalRuntime;
    expect(result.diagnostics).toEqual([]);
    expect(terminalRuntime).toEqual(expect.objectContaining({
      launch: expect.any(Function),
      discoverIdentity: expect.any(Function),
      resolveTranscriptBinding: expect.any(Function),
    }));
    if (!terminalRuntime?.launch || !terminalRuntime.discoverIdentity || !terminalRuntime.resolveTranscriptBinding) {
      throw new Error('Expected merged terminal runtime operations to be available');
    }
    await expect(terminalRuntime.launch({})).resolves.toBe('activated-launched');
    await expect(terminalRuntime.discoverIdentity({})).resolves.toBe('manifest-discover-identity');
    await expect(terminalRuntime.resolveTranscriptBinding({})).resolves.toBe('activated-bind');
    expect(loadPluginDaemonModuleMock).toHaveBeenCalledWith({
      daemonEntryPath: '/tmp/acme-runtime/daemon.mjs',
      cacheKey: 'digest-1',
    });
  });

  it('returns a diagnostic when a backend surface handler export is missing', async () => {
    const backend = createBackendContribution();
    const provider = createProviderContribution();
    const surfaceHandler: BackendSurfaceDeclarationV1 = {
      surfaceApiVersion: 1,
      id: 'backend.terminalRuntime.launch',
      kind: 'terminalRuntime',
      operation: 'launch',
      support: 'supported',
      handler: {
        target: 'daemon',
        exportName: 'launch',
      },
    };
    const backendWithSurfaceHandlers: ResolvedAgentRuntimeContribution = {
      ...backend,
      surfaceHandlers: [surfaceHandler],
    };
    loadPluginDaemonModuleMock.mockResolvedValue({});

    const result = await resolvePluginBackendSurfaceHandlers({
      backend: backendWithSurfaceHandlers,
      provider,
      runtimeRegistry: createRuntimeRegistry(backendWithSurfaceHandlers),
    });

    expect('bindings' in result).toBe(false);
    expect(result.surfaces.terminalRuntime).toBeNull();
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: 'engine_plugin_backend_surface_handler_missing',
        backendId: backend.id,
        providerId: provider.id,
        pluginId: backend.pluginId,
      }),
    ]);
  });

  it('fails closed for prompt-trust plugin backend surface handlers before importing the daemon module', async () => {
    const backend: ResolvedAgentRuntimeContribution = {
      ...createBackendContribution(),
      sourceSpec: {
        kind: 'archive',
        locator: 'https://example.com/acme-runtime.tar.gz',
        trustPolicy: 'prompt',
        installPolicy: 'managed_install',
      },
    } as ResolvedAgentRuntimeContribution;
    const provider = createProviderContribution();
    const backendWithSurfaceHandlers: ResolvedAgentRuntimeContribution = {
      ...backend,
      surfaceHandlers: [{
        surfaceApiVersion: 1,
        id: 'backend.terminalRuntime.launch',
        kind: 'terminalRuntime',
        operation: 'launch',
        support: 'supported',
        handler: {
          target: 'daemon',
          exportName: 'launch',
        },
      }],
    };
    loadPluginDaemonModuleMock.mockRejectedValue(Object.assign(
      new Error('Plugin executable load requires explicit trust approval before loading daemon code'),
      { code: 'PLUGIN_DAEMON_TRUST_APPROVAL_REQUIRED' },
    ));

    const result = await resolvePluginBackendSurfaceHandlers({
      backend: backendWithSurfaceHandlers,
      provider,
      runtimeRegistry: createRuntimeRegistry(backendWithSurfaceHandlers),
    });

    expect(result.surfaces.terminalRuntime).toBeNull();
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: 'engine_plugin_daemon_module_load_failed',
        message: expect.stringMatching(/approval/i),
        backendId: backend.id,
        providerId: provider.id,
        pluginId: backend.pluginId,
      }),
    ]);
    expect(loadPluginDaemonModuleMock).toHaveBeenCalledWith({
      daemonEntryPath: '/tmp/acme-runtime/daemon.mjs',
      cacheKey: 'digest-1',
      trustPolicy: 'prompt',
    });
  });

  it('fails closed for untrusted plugin backend surface handlers before importing the daemon module', async () => {
    const backend: ResolvedAgentRuntimeContribution = {
      ...createBackendContribution(),
      sourceSpec: {
        kind: 'archive',
        locator: 'https://example.com/acme-runtime.tar.gz',
        trustPolicy: 'untrusted',
        installPolicy: 'managed_install',
      },
    } as ResolvedAgentRuntimeContribution;
    const provider = createProviderContribution();
    const backendWithSurfaceHandlers: ResolvedAgentRuntimeContribution = {
      ...backend,
      surfaceHandlers: [{
        surfaceApiVersion: 1,
        id: 'backend.terminalRuntime.launch',
        kind: 'terminalRuntime',
        operation: 'launch',
        support: 'supported',
        handler: {
          target: 'daemon',
          exportName: 'launch',
        },
      }],
    };
    loadPluginDaemonModuleMock.mockRejectedValue(Object.assign(
      new Error('Refusing to load executable plugin daemon entry from an untrusted source'),
      { code: 'PLUGIN_DAEMON_TRUST_UNTRUSTED' },
    ));

    const result = await resolvePluginBackendSurfaceHandlers({
      backend: backendWithSurfaceHandlers,
      provider,
      runtimeRegistry: createRuntimeRegistry(backendWithSurfaceHandlers),
    });

    expect(result.surfaces.terminalRuntime).toBeNull();
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: 'engine_plugin_daemon_module_load_failed',
        message: expect.stringMatching(/untrusted/i),
        backendId: backend.id,
        providerId: provider.id,
        pluginId: backend.pluginId,
      }),
    ]);
    expect(loadPluginDaemonModuleMock).toHaveBeenCalledWith({
      daemonEntryPath: '/tmp/acme-runtime/daemon.mjs',
      cacheKey: 'digest-1',
      trustPolicy: 'untrusted',
    });
  });

  it('routes terminal runtime surfaces by canonical operation rather than opaque surface handler id', async () => {
    const backend = createBackendContribution();
    const provider = createProviderContribution();
    const surfaceHandler = {
      surfaceApiVersion: 1,
      id: 'launch-adapter',
      kind: 'terminalRuntime',
      operation: 'launch',
      support: 'supported',
      handler: {
        target: 'daemon',
        exportName: 'launch',
      },
    } as BackendSurfaceDeclarationV1;
    const backendWithSurfaceHandlers: ResolvedAgentRuntimeContribution = {
      ...backend,
      surfaceHandlers: [surfaceHandler],
    };
    const launch = vi.fn(async () => 'launched');
    loadPluginDaemonModuleMock.mockResolvedValue({
      launch,
    });

    const result = await resolvePluginBackendSurfaceHandlers({
      backend: backendWithSurfaceHandlers,
      provider,
      runtimeRegistry: createRuntimeRegistry(backendWithSurfaceHandlers),
    });

    expect(result.diagnostics).toEqual([]);
    await expect(result.surfaces.terminalRuntime?.launch?.({})).resolves.toBe('launched');
  });

  it('ignores statically unsupported surface handlers without loading daemon code', async () => {
    const backend = createBackendContribution();
    const provider = createProviderContribution();
    const surfaceHandler: BackendSurfaceDeclarationV1 = {
      surfaceApiVersion: 1,
      id: 'backend.terminalRuntime.launch',
      kind: 'terminalRuntime',
      operation: 'launch',
      support: 'unsupported',
      handler: {
        target: 'daemon',
        exportName: 'launch',
      },
    };
    const backendWithSurfaceHandlers: ResolvedAgentRuntimeContribution = {
      ...backend,
      surfaceHandlers: [surfaceHandler],
    };
    loadPluginDaemonModuleMock.mockRejectedValue(new Error('unsupported surface should not load daemon code'));

    const result = await resolvePluginBackendSurfaceHandlers({
      backend: backendWithSurfaceHandlers,
      provider,
      runtimeRegistry: createRuntimeRegistry(backendWithSurfaceHandlers),
    });

    expect(result.surfaces).toEqual(expect.objectContaining({
      terminalRuntime: null,
    }));
    expect(loadPluginDaemonModuleMock).not.toHaveBeenCalled();
  });
});
