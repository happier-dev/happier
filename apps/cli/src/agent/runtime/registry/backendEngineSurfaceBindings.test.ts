import { describe, expect, it, vi } from 'vitest';
import { BackendSurfaceOperationCatalogV1, type BackendSurfaceDeclarationV1 } from '@happier-dev/protocol';
import type { BackendEngineV1, ExternalSessionRuntimeContextV1 } from '@happier-dev/plugin-sdk';

import {
  createEmptyBackendExecutionSurfaces,
  type BackendExecutionSurfaces,
} from './engineRegistryTypes';
import type { ResolvedBackendContribution } from '../../../plugins/projection/registry/types';
import {
  mergeBackendExecutionSurfaces,
  resolveBackendExecutionSurfacesFromEngine,
} from './backendEngineSurfaceBindings';

function createSurfaceHandler(
  kind: BackendSurfaceDeclarationV1['kind'],
  operation: BackendSurfaceDeclarationV1['operation'],
): BackendSurfaceDeclarationV1 {
  return {
    surfaceApiVersion: 1,
    id: `${kind}.${operation}`,
    kind,
    operation,
    support: 'supported',
    handler: {
      target: 'daemon',
      exportName: operation,
    },
  };
}

function createBackend(surfaceHandlers: readonly BackendSurfaceDeclarationV1[]): ResolvedBackendContribution {
  return {
    id: 'acme.runtime.backend',
    providerId: 'acme.runtime.provider',
    provenance: 'external',
    source: { kind: 'path' },
    definition: {
      kindVersion: 1,
      id: 'acme.runtime.backend',
      providerId: 'acme.runtime.provider',
    },
    runtimeKind: 'custom',
    capabilities: {
      executionRun: { supported: false },
        session: {
          media: {
            acceptsImageInput: { supported: false },
            emitsSessionMedia: { supported: false },
            nativeImageGeneration: { supported: false },
          },
          contextCompaction: {
            events: { supported: false },
            manualTrigger: { supported: false },
            transcriptInference: { supported: false },
          },
        },
      },
    surfaceHandlers,
    pluginId: 'acme.runtime',
    manifestPath: '/plugins/acme.runtime/.happier-plugin/plugin.json',
    manifestDigest: 'digest-1',
    daemonEntryPath: '/plugins/acme.runtime/daemon.mjs',
  };
}

const source = { kind: 'codexHome', home: 'user' } as const;
const rawSession = Object.freeze({}) as Parameters<NonNullable<NonNullable<BackendExecutionSurfaces['externalSession']>['resolveTakeoverSpawnOptions']>>[0]['linked']['rawSession'];
type EngineExternalSessionSurface = NonNullable<BackendEngineV1['externalSessionSurface']>;

function createLinkedSession(
  overrides: Partial<Parameters<NonNullable<NonNullable<BackendExecutionSurfaces['externalSession']>['resolveTakeoverSpawnOptions']>>[0]['linked']> = {},
): Parameters<NonNullable<NonNullable<BackendExecutionSurfaces['externalSession']>['resolveTakeoverSpawnOptions']>>[0]['linked'] {
  return {
    rawSession,
    metadata: { path: '/repo/from-metadata' },
    sessionPath: '/repo/from-session-path',
    providerId: 'claude',
    machineId: 'machine-1',
    remoteSessionId: 'provider-session-1',
    source: { kind: 'claudeConfig', configDir: '/tmp/.claude', projectId: 'project-1' },
    codexBackendMode: null,
    ...overrides,
  };
}

function createExternalSessionSurfaceFixture(
  overrides: Partial<EngineExternalSessionSurface>,
): EngineExternalSessionSurface {
  return {
    resolveSource: async (request) => ({ ok: true, value: { source: request.source } }),
    listCandidates: async () => ({ ok: true, value: { candidates: [], nextCursor: null } }),
    pageTranscript: async () => ({ ok: true, value: { items: [], nextCursor: null } }),
    ...overrides,
  };
}

describe('mergeBackendExecutionSurfaces', () => {
  it('fails closed when handler and engine surfaces both implement the same operation', () => {
    const handlerLaunch = vi.fn();
    const engineLaunch = vi.fn();

    const handlerSurfaces: BackendExecutionSurfaces = {
      ...createEmptyBackendExecutionSurfaces(),
      terminalRuntime: {
        launch: handlerLaunch,
      } as NonNullable<BackendExecutionSurfaces['terminalRuntime']>,
    };
    const engineSurfaces: BackendExecutionSurfaces = {
      ...createEmptyBackendExecutionSurfaces(),
      terminalRuntime: {
        launch: engineLaunch,
      } as NonNullable<BackendExecutionSurfaces['terminalRuntime']>,
    };

    expect(() => mergeBackendExecutionSurfaces(handlerSurfaces, engineSurfaces)).toThrow(/duplicate.*terminalRuntime\.launch/i);
  });
});

describe('resolveBackendExecutionSurfacesFromEngine', () => {
  it('materializes all six final surface families from declared engine surface bindings', async () => {
    const catalog = BackendSurfaceOperationCatalogV1;
    const backend = createBackend([
      createSurfaceHandler('terminalRuntime', catalog.terminalRuntime.evaluateAvailability),
      createSurfaceHandler('terminalRuntime', catalog.terminalRuntime.launch),
      createSurfaceHandler('externalSession', catalog.externalSession.evaluateAvailability),
      createSurfaceHandler('externalSession', catalog.externalSession.resolveSource),
      createSurfaceHandler('externalSession', catalog.externalSession.listCandidates),
      createSurfaceHandler('externalSession', catalog.externalSession.pageTranscript),
      createSurfaceHandler('attach', catalog.attach.evaluateAvailability),
      createSurfaceHandler('attach', catalog.attach.attach),
      createSurfaceHandler('handoff', catalog.handoff.evaluateAvailability),
      createSurfaceHandler('handoff', catalog.handoff.exportBundle),
      createSurfaceHandler('handoff', catalog.handoff.importBundle),
      createSurfaceHandler('fork', catalog.fork.evaluateAvailability),
      createSurfaceHandler('fork', catalog.fork.fork),
      createSurfaceHandler('fork', catalog.fork.resolveReplayChildLaunch),
      createSurfaceHandler('checkpoint', catalog.checkpoint.evaluateAvailability),
      createSurfaceHandler('checkpoint', catalog.checkpoint.list),
      createSurfaceHandler('checkpoint', catalog.checkpoint.resolveRestoreTarget),
      createSurfaceHandler('checkpoint', catalog.checkpoint.checkpoint),
      createSurfaceHandler('checkpoint', catalog.checkpoint.restore),
    ]);
    const engine = {
      terminalRuntimeSurface: {
        evaluateAvailability: async (request) => request.operation === 'launch'
          ? { available: true }
          : { available: false, reasonCode: 'unsupported' },
        launch: async (request) => ({
          type: 'control_returned',
          reason: 'switch_requested',
          providerSessionId: request.sessionId,
        }),
      },
      externalSessionSurface: {
        evaluateAvailability: async (request) => request.operation === 'resolveSource'
          ? { available: true }
          : { available: false, reasonCode: 'unsupported' },
        resolveSource: async (request) => ({ ok: true, value: { source: request.source } }),
        listCandidates: async () => ({ ok: true, value: { candidates: [], nextCursor: null } }),
        pageTranscript: async () => ({
          ok: true,
          value: { items: [], nextCursor: null, tailCursor: null, hasMore: false },
        }),
      },
      attachSurface: {
        evaluateAvailability: async () => ({ available: true }),
        attach: async () => ({ ok: true, value: { exitCode: 0 } }),
      },
      handoffSurface: {
        evaluateAvailability: async () => ({ available: true }),
        exportBundle: async () => ({ ok: true, value: { bundle: { token: 'bundle-1' } } }),
        importBundle: async () => ({
          ok: true,
          value: {
            providerSessionId: 'vendor-imported',
            source,
            launch: { directory: '/tmp/imported' },
          },
        }),
      },
      forkSurface: {
        evaluateAvailability: async () => ({ available: true }),
        fork: async () => ({
          providerSessionId: 'vendor-child',
          launch: { directory: '/tmp/fork-child' },
        }),
        resolveReplayChildLaunch: async () => ({ directory: '/tmp/replay-child' }),
      },
      checkpointSurface: {
        evaluateAvailability: async () => ({ available: true }),
        list: async () => [],
        resolveRestoreTarget: async () => ({ kind: 'provider_checkpoint', checkpointId: 'checkpoint-1' }),
        checkpoint: async () => ({
          id: 'checkpoint-1',
          target: { kind: 'provider_checkpoint', checkpointId: 'checkpoint-1' },
          timing: 'idle',
          checkpointScopes: ['conversation'],
          restoreScopes: ['conversation'],
        }),
        restore: async () => ({
          ok: true,
          outcome: 'completed',
          restoredScopes: ['conversation'],
        }),
      },
    } satisfies BackendEngineV1;
    const diagnostics: Parameters<typeof resolveBackendExecutionSurfacesFromEngine>[0]['diagnostics'] = [];

    const surfaces = resolveBackendExecutionSurfacesFromEngine({ backend, engine, diagnostics });

    expect(diagnostics).toEqual([]);
    await expect(surfaces.terminalRuntime?.evaluateAvailability?.({
      operation: 'launch',
      sessionId: 'terminal-session',
      metadata: {},
      directory: '/repo',
    })).resolves.toEqual({ available: true });
    await expect(surfaces.terminalRuntime?.launch?.({
      sessionId: 'terminal-session',
      metadata: {},
      directory: '/repo',
    })).resolves.toEqual(expect.objectContaining({
      type: 'control_returned',
      providerSessionId: 'terminal-session',
    }));
    await expect(surfaces.externalSession?.evaluateAvailability?.({
      operation: 'resolveSource',
      source,
    })).resolves.toEqual({ available: true });
    await expect(surfaces.externalSession?.validateSource?.({ source, env: {} })).resolves.toEqual({
      ok: true,
      source,
    });
    await expect(surfaces.attach?.evaluateAvailability({
      sessionId: 'session-1',
      metadata: {},
      currentMachineId: 'machine-1',
      sessionMachineId: 'machine-1',
      hasLocalAttachmentInfo: true,
    })).resolves.toEqual({ eligible: true, scope: 'local', metadata: {} });
    await expect(surfaces.handoff?.evaluateAvailability?.({
      operation: 'exportBundle',
      sessionId: 'session-1',
      metadata: {},
    })).resolves.toEqual({ available: true });
    await expect(surfaces.fork?.evaluateAvailability?.({
      operation: 'fork',
      parentSessionId: 'session-1',
      parentMetadata: {},
      directory: '/repo',
      forkPoint: { kind: 'latest' },
    })).resolves.toEqual({ available: true });
    await expect(surfaces.checkpoint?.restore?.({
      sessionId: 'session-1',
      target: { kind: 'provider_checkpoint', checkpointId: 'checkpoint-1' },
      scopes: ['conversation'],
    })).resolves.toEqual({
      ok: true,
      outcome: 'completed',
      restoredScopes: ['conversation'],
    });
  });

  it('injects resolved session services into engine terminal launch requests', async () => {
    const catalog = BackendSurfaceOperationCatalogV1;
    const backend = createBackend([
      createSurfaceHandler('terminalRuntime', catalog.terminalRuntime.launch),
    ]);
    const services = Object.freeze({ sessionId: 'terminal-session' });
    const abortController = new AbortController();
    const launch = vi.fn(async () => ({
      type: 'control_returned' as const,
      reason: 'switch_requested' as const,
    }));
    const engine = {
      terminalRuntimeSurface: {
        launch,
      },
    } satisfies BackendEngineV1;
    const diagnostics: Parameters<typeof resolveBackendExecutionSurfacesFromEngine>[0]['diagnostics'] = [];

    const surfaces = resolveBackendExecutionSurfacesFromEngine({
      backend,
      engine,
      diagnostics,
      resolveTerminalRuntimeLaunchServices: async (request: { sessionId: string }) => (
        request.sessionId === 'terminal-session' ? services : null
      ),
      resolveTerminalRuntimeLaunchSignal: () => abortController.signal,
    } as never);

    await expect(surfaces.terminalRuntime?.launch?.({
      sessionId: 'terminal-session',
      metadata: {},
      directory: '/repo',
    })).resolves.toEqual({
      type: 'control_returned',
      reason: 'switch_requested',
    });
    expect(launch).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'terminal-session',
      metadata: {},
      directory: '/repo',
      services,
      signal: abortController.signal,
    }));
  });

  it('injects terminal host orchestration into engine terminal launch requests', async () => {
    const catalog = BackendSurfaceOperationCatalogV1;
    const backend = createBackend([
      createSurfaceHandler('terminalRuntime', catalog.terminalRuntime.launch),
    ]);
    const host = Object.freeze({
      input: Object.freeze({ subscribe: vi.fn() }),
      switching: Object.freeze({ register: vi.fn() }),
      process: Object.freeze({ launch: vi.fn() }),
      transcripts: Object.freeze({ openDirectMirror: vi.fn() }),
      projection: Object.freeze({
        openDirectTranscriptMirror: vi.fn(),
        publishControlState: vi.fn(),
        publishProviderSessionId: vi.fn(),
        publishSubagentStarted: vi.fn(),
        publishSubagentCompleted: vi.fn(),
      }),
    });
    const launch = vi.fn(async () => ({
      type: 'control_returned' as const,
      reason: 'switch_requested' as const,
    }));
    const engine = {
      terminalRuntimeSurface: {
        launch,
      },
    } satisfies BackendEngineV1;
    const diagnostics: Parameters<typeof resolveBackendExecutionSurfacesFromEngine>[0]['diagnostics'] = [];

    const surfaces = resolveBackendExecutionSurfacesFromEngine({
      backend,
      engine,
      diagnostics,
      resolveTerminalRuntimeHostOrchestration: async (request: { sessionId: string }) => (
        request.sessionId === 'terminal-session' ? host : null
      ),
    } as never);

    await expect(surfaces.terminalRuntime?.launch?.({
      sessionId: 'terminal-session',
      metadata: {},
      directory: '/repo',
    })).resolves.toEqual({
      type: 'control_returned',
      reason: 'switch_requested',
    });
    expect(launch).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'terminal-session',
      metadata: {},
      directory: '/repo',
      host,
    }));
  });

  it('fails closed before engine terminal launch when host projection cannot be resolved', async () => {
    const catalog = BackendSurfaceOperationCatalogV1;
    const backend = createBackend([
      createSurfaceHandler('terminalRuntime', catalog.terminalRuntime.launch),
    ]);
    const malformedHost = Object.freeze({
      input: Object.freeze({ subscribe: vi.fn() }),
      switching: Object.freeze({ register: vi.fn() }),
      process: Object.freeze({ launch: vi.fn() }),
      transcripts: Object.freeze({ openDirectMirror: vi.fn() }),
    });
    const launch = vi.fn(async () => ({
      type: 'control_returned' as const,
      reason: 'switch_requested' as const,
    }));
    const engine = {
      terminalRuntimeSurface: {
        launch,
      },
    } satisfies BackendEngineV1;
    const diagnostics: Parameters<typeof resolveBackendExecutionSurfacesFromEngine>[0]['diagnostics'] = [];

    const surfaces = resolveBackendExecutionSurfacesFromEngine({
      backend,
      engine,
      diagnostics,
      resolveTerminalRuntimeHostOrchestration: async () => malformedHost,
    } as never);

    await expect(surfaces.terminalRuntime?.launch?.({
      sessionId: 'terminal-session',
      metadata: {},
      directory: '/repo',
    })).rejects.toThrow(/terminal host projection/i);
    expect(launch).not.toHaveBeenCalled();
  });

  it('fails closed before engine terminal launch when host projection cannot open transcript mirrors', async () => {
    const catalog = BackendSurfaceOperationCatalogV1;
    const backend = createBackend([
      createSurfaceHandler('terminalRuntime', catalog.terminalRuntime.launch),
    ]);
    const malformedHost = Object.freeze({
      input: Object.freeze({ subscribe: vi.fn() }),
      switching: Object.freeze({ register: vi.fn() }),
      process: Object.freeze({ launch: vi.fn() }),
      transcripts: Object.freeze({ openDirectMirror: vi.fn() }),
      projection: Object.freeze({
        publishControlState: vi.fn(),
        publishProviderSessionId: vi.fn(),
        publishSubagentStarted: vi.fn(),
        publishSubagentCompleted: vi.fn(),
      }),
    });
    const launch = vi.fn(async () => ({
      type: 'control_returned' as const,
      reason: 'switch_requested' as const,
    }));
    const engine = {
      terminalRuntimeSurface: {
        launch,
      },
    } satisfies BackendEngineV1;
    const diagnostics: Parameters<typeof resolveBackendExecutionSurfacesFromEngine>[0]['diagnostics'] = [];

    const surfaces = resolveBackendExecutionSurfacesFromEngine({
      backend,
      engine,
      diagnostics,
      resolveTerminalRuntimeHostOrchestration: async () => malformedHost,
    } as never);

    await expect(surfaces.terminalRuntime?.launch?.({
      sessionId: 'terminal-session',
      metadata: {},
      directory: '/repo',
    })).rejects.toThrow(/terminal host projection/i);
    expect(launch).not.toHaveBeenCalled();
  });

  it('injects narrow runtime context into engine external-session requests', async () => {
    const catalog = BackendSurfaceOperationCatalogV1;
    const backend = createBackend([
      createSurfaceHandler('externalSession', catalog.externalSession.listCandidates),
    ]);
    const abortController = new AbortController();
    const diagnosticsIssue = vi.fn();
    const services = Object.freeze({ sessionId: 'session-1' });
    const fileFollow = Object.freeze({ follow: vi.fn() });
    const transcriptStore = Object.freeze({
      getActivity: vi.fn(),
      page: vi.fn(),
      readAfter: vi.fn(),
      acquireFollowLease: vi.fn(),
      resolveFollowTranscriptPath: vi.fn(),
      getWorkingDirectory: vi.fn(),
      getProviderHome: vi.fn(),
    });
    const candidateHost = Object.freeze({
      listViaChildHost: vi.fn(),
    });
    const runtime = Object.freeze({
      signal: abortController.signal,
      session: Object.freeze({
        sessionId: 'session-1',
        directory: '/repo/project',
        services,
      }),
      directories: Object.freeze({
        activeServerDir: '/happy/servers/current',
        logsDir: '/happy/logs',
      }),
      transcripts: Object.freeze({
        fileFollow,
      }),
      external: Object.freeze({
        transcripts: transcriptStore,
        candidates: candidateHost,
      }),
      diagnostics: Object.freeze({
        issue: diagnosticsIssue,
      }),
    });
    const listCandidates = vi.fn(async (_request: Parameters<NonNullable<EngineExternalSessionSurface['listCandidates']>>[0]) => ({
      ok: true as const,
      value: { candidates: [], nextCursor: null },
    }));
    const engine = {
      externalSessionSurface: createExternalSessionSurfaceFixture({
        listCandidates,
      }),
    } satisfies BackendEngineV1;
    const diagnostics: Parameters<typeof resolveBackendExecutionSurfacesFromEngine>[0]['diagnostics'] = [];

    const surfaces = resolveBackendExecutionSurfacesFromEngine({
      backend,
      engine,
      diagnostics,
      resolveExternalSessionRuntimeContext: async () => runtime,
    } as never);

    await expect(surfaces.externalSession?.listCandidates?.({
      source,
      limit: 5,
    })).resolves.toEqual({
      candidates: [],
      nextCursor: null,
    });
    const expectedRuntime = {
      signal: abortController.signal,
      session: {
        sessionId: 'session-1',
        directory: '/repo/project',
      },
      directories: {
        activeServerDir: '/happy/servers/current',
        logsDir: '/happy/logs',
      },
      transcripts: {
        fileFollow,
      },
      external: {
        transcripts: transcriptStore,
        candidates: candidateHost,
      },
      diagnostics: {
        issue: diagnosticsIssue,
      },
    };
    expect(listCandidates).toHaveBeenCalledWith({
      source,
      limit: 5,
      runtime: expectedRuntime,
    });
    expect(listCandidates.mock.calls[0]?.[0]?.runtime?.session)
      .not.toHaveProperty('services');
  });

  it('grants a resolved external-session transcript path before acquiring a follow lease', async () => {
    const catalog = BackendSurfaceOperationCatalogV1;
    const transcriptPath = '/tmp/happier-external-follow.jsonl';
    const backend = createBackend([
      createSurfaceHandler('externalSession', catalog.externalSession.resolveFollowTranscriptPath),
      createSurfaceHandler('externalSession', catalog.externalSession.acquireFollowLease),
    ]);
    const runtime = Object.freeze({
      signal: new AbortController().signal,
      session: Object.freeze({
        sessionId: 'happy-session-1',
        directory: '/repo/project',
      }),
      transcripts: Object.freeze({
        fileFollow: Object.freeze({ follow: vi.fn() }),
      }),
      diagnostics: Object.freeze({
        issue: vi.fn(),
      }),
    });
    const resolveFollowTranscriptPath = vi.fn(async () => ({
      ok: true as const,
      value: {
        path: transcriptPath,
        sourceId: 'trusted-source-1',
      },
    }));
    const acquireFollowLease = vi.fn(async () => ({
      ok: true as const,
      value: {
        release: vi.fn(async () => undefined),
        getTailCursor: () => 'tail-1',
      },
    }));
    const grantExternalSessionTranscriptPath = vi.fn(async () => undefined);
    const runExternalSessionFollowWithLinkedSession = vi.fn(async (
      _sessionId: string | null,
      operation: () => Promise<unknown>,
    ) => await operation());
    const engine = {
      externalSessionSurface: {
        ...createExternalSessionSurfaceFixture({}),
        resolveFollowTranscriptPath,
        acquireFollowLease,
      } as EngineExternalSessionSurface,
    } satisfies BackendEngineV1;
    const diagnostics: Parameters<typeof resolveBackendExecutionSurfacesFromEngine>[0]['diagnostics'] = [];

    const surfaces = resolveBackendExecutionSurfacesFromEngine({
      backend,
      engine,
      diagnostics,
      resolveExternalSessionRuntimeContext: async () => runtime,
      grantExternalSessionTranscriptPath,
      runExternalSessionFollowWithLinkedSession,
    } as never);

    await expect(surfaces.externalSession?.acquireFollowLease?.({
      source,
      remoteSessionId: 'remote-session-1',
      reason: 'attached_view',
      linkedSessionId: 'happy-session-1',
    })).resolves.toEqual(expect.objectContaining({
      getTailCursor: expect.any(Function),
    }));
    expect(resolveFollowTranscriptPath).toHaveBeenCalledWith({
      source,
      providerSessionId: 'remote-session-1',
      reason: 'attached_view',
      linkedSessionId: 'happy-session-1',
      runtime,
    });
    expect(grantExternalSessionTranscriptPath).toHaveBeenCalledWith({
      path: transcriptPath,
      source,
      providerSessionId: 'remote-session-1',
      sourceId: 'trusted-source-1',
      sessionId: 'happy-session-1',
    });
    expect(runExternalSessionFollowWithLinkedSession).toHaveBeenCalledWith('happy-session-1', expect.any(Function));
    expect(acquireFollowLease).toHaveBeenCalledWith({
      source,
      providerSessionId: 'remote-session-1',
      reason: 'attached_view',
      linkedSessionId: 'happy-session-1',
      runtime,
    });
  });

  it('fails closed before external-session file-follow acquisition without a trusted path resolver', async () => {
    const catalog = BackendSurfaceOperationCatalogV1;
    const backend = createBackend([
      createSurfaceHandler('externalSession', catalog.externalSession.acquireFollowLease),
    ]);
    const acquireFollowLease = vi.fn(async () => ({
      ok: true as const,
      value: {
        release: vi.fn(async () => undefined),
      },
    }));
    const engine = {
      externalSessionSurface: createExternalSessionSurfaceFixture({
        acquireFollowLease,
      }),
    } satisfies BackendEngineV1;
    const diagnostics: Parameters<typeof resolveBackendExecutionSurfacesFromEngine>[0]['diagnostics'] = [];

    const surfaces = resolveBackendExecutionSurfacesFromEngine({
      backend,
      engine,
      diagnostics,
      grantExternalSessionTranscriptPath: vi.fn(async () => undefined),
    } as never);

    await expect(surfaces.externalSession?.acquireFollowLease?.({
      source,
      remoteSessionId: 'remote-session-1',
      reason: 'attached_view',
    })).rejects.toThrow(/resolveFollowTranscriptPath/);
    expect(acquireFollowLease).not.toHaveBeenCalled();
  });

  it('injects typed ACP session operations into engine fork requests', async () => {
    const catalog = BackendSurfaceOperationCatalogV1;
    const backend = createBackend([
      createSurfaceHandler('fork', catalog.fork.fork),
    ]);
    const acp = Object.freeze({
      loadSession: vi.fn(async () => ({
        ok: true as const,
        value: { providerSessionId: 'parent-provider-session' },
      })),
      forkSession: vi.fn(async () => ({
        ok: true as const,
        value: { providerSessionId: 'child-provider-session' },
      })),
    });
    const fork = vi.fn(async () => ({
      providerSessionId: 'child-provider-session',
      launch: {},
    }));
    const engine = {
      forkSurface: {
        fork,
      },
    } satisfies BackendEngineV1;
    const diagnostics: Parameters<typeof resolveBackendExecutionSurfacesFromEngine>[0]['diagnostics'] = [];

    const surfaces = resolveBackendExecutionSurfacesFromEngine({
      backend,
      engine,
      diagnostics,
      resolveAcpSessionOperations: async () => acp,
    } as never);

    await expect(surfaces.fork?.fork?.({
      parentSessionId: 'parent-session',
      parentMetadata: {},
      directory: '/repo/project',
      forkPoint: { kind: 'latest' },
    })).resolves.toEqual({
      providerSessionId: 'child-provider-session',
      launch: {},
    });
    expect(fork).toHaveBeenCalledWith({
      parentSessionId: 'parent-session',
      parentMetadata: {},
      directory: '/repo/project',
      forkPoint: { kind: 'latest' },
      acp,
    });
  });

  it('fails closed before engine terminal launch when session services cannot be resolved', async () => {
    const catalog = BackendSurfaceOperationCatalogV1;
    const backend = createBackend([
      createSurfaceHandler('terminalRuntime', catalog.terminalRuntime.launch),
    ]);
    const launch = vi.fn(async () => ({
      type: 'control_returned' as const,
      reason: 'switch_requested' as const,
    }));
    const engine = {
      terminalRuntimeSurface: {
        launch,
      },
    } satisfies BackendEngineV1;
    const diagnostics: Parameters<typeof resolveBackendExecutionSurfacesFromEngine>[0]['diagnostics'] = [];

    const surfaces = resolveBackendExecutionSurfacesFromEngine({
      backend,
      engine,
      diagnostics,
      resolveTerminalRuntimeLaunchServices: async () => null,
      resolveTerminalRuntimeLaunchSignal: () => new AbortController().signal,
    } as never);

    await expect(surfaces.terminalRuntime?.launch?.({
      sessionId: 'terminal-session',
      metadata: {},
      directory: '/repo',
    })).rejects.toThrow(/session-scoped services/i);
    expect(launch).not.toHaveBeenCalled();
  });

  it('fails closed before engine terminal launch when host orchestration cannot be resolved', async () => {
    const catalog = BackendSurfaceOperationCatalogV1;
    const backend = createBackend([
      createSurfaceHandler('terminalRuntime', catalog.terminalRuntime.launch),
    ]);
    const launch = vi.fn(async () => ({
      type: 'control_returned' as const,
      reason: 'switch_requested' as const,
    }));
    const engine = {
      terminalRuntimeSurface: {
        launch,
      },
    } satisfies BackendEngineV1;
    const diagnostics: Parameters<typeof resolveBackendExecutionSurfacesFromEngine>[0]['diagnostics'] = [];

    const surfaces = resolveBackendExecutionSurfacesFromEngine({
      backend,
      engine,
      diagnostics,
      resolveTerminalRuntimeHostOrchestration: async () => null,
    } as never);

    await expect(surfaces.terminalRuntime?.launch?.({
      sessionId: 'terminal-session',
      metadata: {},
      directory: '/repo',
    })).rejects.toThrow(/terminal host orchestration/i);
    expect(launch).not.toHaveBeenCalled();
  });

  it('omits undeclared engine surface operations and records a static mismatch diagnostic', () => {
    const backend = createBackend([]);
    const engine = {
      forkSurface: {
        fork: async () => ({
          providerSessionId: 'vendor-child',
          launch: { directory: '/tmp/fork-child' },
        }),
      },
    } satisfies BackendEngineV1;
    const diagnostics: Parameters<typeof resolveBackendExecutionSurfacesFromEngine>[0]['diagnostics'] = [];

    const surfaces = resolveBackendExecutionSurfacesFromEngine({ backend, engine, diagnostics });

    expect(surfaces.fork).toBeNull();
    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: 'engine_plugin_backend_surface_static_mismatch',
        message: expect.stringContaining('fork:fork'),
        backendId: backend.id,
        pluginId: backend.pluginId,
      }),
    ]);
  });

  it('maps thrown availability evaluators to fail-closed evaluation_error results', async () => {
    const catalog = BackendSurfaceOperationCatalogV1;
    const backend = createBackend([
      createSurfaceHandler('attach', catalog.attach.evaluateAvailability),
      createSurfaceHandler('attach', catalog.attach.attach),
      createSurfaceHandler('handoff', catalog.handoff.evaluateAvailability),
      createSurfaceHandler('handoff', catalog.handoff.exportBundle),
      createSurfaceHandler('handoff', catalog.handoff.importBundle),
      createSurfaceHandler('fork', catalog.fork.evaluateAvailability),
      createSurfaceHandler('fork', catalog.fork.fork),
      createSurfaceHandler('checkpoint', catalog.checkpoint.evaluateAvailability),
    ]);
    const throwAvailability = async () => {
      throw new Error('provider exploded');
    };
    const engine = {
      attachSurface: {
        evaluateAvailability: throwAvailability,
        attach: async () => ({ ok: true, value: { exitCode: 0 } }),
      },
      handoffSurface: {
        evaluateAvailability: throwAvailability,
        exportBundle: async () => ({ ok: true, value: { bundle: {} } }),
        importBundle: async () => ({
          ok: true,
          value: { providerSessionId: 'vendor-imported', launch: {} },
        }),
      },
      forkSurface: {
        evaluateAvailability: throwAvailability,
        fork: async () => ({ providerSessionId: 'vendor-child', launch: {} }),
      },
      checkpointSurface: {
        evaluateAvailability: throwAvailability,
      },
    } satisfies BackendEngineV1;
    const diagnostics: Parameters<typeof resolveBackendExecutionSurfacesFromEngine>[0]['diagnostics'] = [];

    const surfaces = resolveBackendExecutionSurfacesFromEngine({ backend, engine, diagnostics });

    await expect(surfaces.attach?.evaluateAvailability({
      sessionId: 'session-1',
      metadata: {},
      currentMachineId: null,
      sessionMachineId: null,
      hasLocalAttachmentInfo: false,
    })).resolves.toEqual({ eligible: false, reason: 'evaluation_error' });
    await expect(surfaces.handoff?.evaluateAvailability?.({
      operation: 'exportBundle',
      sessionId: 'session-1',
      metadata: {},
    })).resolves.toEqual({ available: false, reasonCode: 'evaluation_error' });
    await expect(surfaces.fork?.evaluateAvailability?.({
      operation: 'fork',
      parentSessionId: 'session-1',
      parentMetadata: {},
      directory: '/repo',
      forkPoint: { kind: 'latest' },
    })).resolves.toEqual({ available: false, reasonCode: 'evaluation_error' });
    await expect(surfaces.checkpoint?.evaluateAvailability?.({
      operation: 'restore',
      sessionId: 'session-1',
      target: { kind: 'provider_checkpoint', checkpointId: 'checkpoint-1' },
      scopes: ['conversation'],
      timing: 'idle',
    })).resolves.toEqual({ available: false, reasonCode: 'evaluation_error' });
  });

  it('preserves host direct-session takeover context around engine launch hints', async () => {
    const catalog = BackendSurfaceOperationCatalogV1;
    const backend = {
      ...createBackend([
        createSurfaceHandler('externalSession', catalog.externalSession.resolveTakeoverLaunch),
      ]),
      id: 'claude',
      providerId: 'claude',
      provenance: 'first_party',
      source: { kind: 'bundled' },
    } satisfies ResolvedBackendContribution;
    const resolveTakeoverLaunch = vi.fn(async (_request: Parameters<NonNullable<EngineExternalSessionSurface['resolveTakeoverLaunch']>>[0]) => ({
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
    const engine = {
      externalSessionSurface: createExternalSessionSurfaceFixture({
        resolveTakeoverLaunch,
      }),
    } satisfies BackendEngineV1;
    const diagnostics: Parameters<typeof resolveBackendExecutionSurfacesFromEngine>[0]['diagnostics'] = [];

    const surfaces = resolveBackendExecutionSurfacesFromEngine({ backend, engine, diagnostics });

    await expect(surfaces.externalSession?.resolveTakeoverSpawnOptions?.({
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

  it('does not expose session-scoped services through external-session runtime context', async () => {
    const catalog = BackendSurfaceOperationCatalogV1;
    const backend = createBackend([
      createSurfaceHandler('externalSession', catalog.externalSession.resolveTakeoverLaunch),
    ]);
    const resolveTakeoverLaunch = vi.fn(async (_request: Parameters<NonNullable<EngineExternalSessionSurface['resolveTakeoverLaunch']>>[0]) => ({
      ok: true as const,
      value: {
        providerSessionId: 'provider-session-1',
        source,
        launch: {
          directory: '/repo/from-provider',
        },
      },
    }));
    const engine = {
      externalSessionSurface: createExternalSessionSurfaceFixture({
        resolveTakeoverLaunch,
      }),
    } satisfies BackendEngineV1;
    const diagnostics: Parameters<typeof resolveBackendExecutionSurfacesFromEngine>[0]['diagnostics'] = [];
    const serviceBag = Object.freeze({
      send: vi.fn(),
      writeMetadata: vi.fn(),
      writeAgentState: vi.fn(),
    });
    const runtime = Object.freeze({
      signal: new AbortController().signal,
      session: Object.freeze({
        sessionId: 'happy-session-1',
        directory: '/repo/from-session-path',
        services: serviceBag,
      }),
      directories: Object.freeze({
        activeServerDir: '/happy/server',
        logsDir: '/happy/logs',
        env: process.env,
      }),
      transcripts: Object.freeze({
        fileFollow: Object.freeze({ follow: vi.fn() }),
        rawClient: Object.freeze({ request: vi.fn() }),
      }),
      external: Object.freeze({
        transcripts: Object.freeze({
          getActivity: vi.fn(),
          page: vi.fn(),
          readAfter: vi.fn(),
          acquireFollowLease: vi.fn(),
          resolveFollowTranscriptPath: vi.fn(),
          getWorkingDirectory: vi.fn(),
          getProviderHome: vi.fn(),
        }),
        candidates: Object.freeze({
          listViaChildHost: vi.fn(),
        }),
        rawClient: Object.freeze({ request: vi.fn() }),
      }),
      diagnostics: Object.freeze({
        issue: vi.fn(),
        hostServices: serviceBag,
      }),
      hostServices: serviceBag,
    });

    const surfaces = resolveBackendExecutionSurfacesFromEngine({
      backend,
      engine,
      diagnostics,
      resolveExternalSessionRuntimeContext: async () => runtime as never,
    });

    await expect(surfaces.externalSession?.resolveTakeoverSpawnOptions?.({
      linked: createLinkedSession({ source }),
      sessionId: 'happy-session-1',
    })).resolves.toMatchObject({
      directory: '/repo/from-provider',
    });
    const runtimeArg = resolveTakeoverLaunch.mock.calls[0]?.[0]?.runtime as ExternalSessionRuntimeContextV1 | undefined;
    expect(runtimeArg?.session).toEqual({
      sessionId: 'happy-session-1',
      directory: '/repo/from-session-path',
    });
    expect(runtimeArg?.session).not.toHaveProperty('services');
    expect(runtimeArg).not.toHaveProperty('hostServices');
    expect(runtimeArg?.directories).toEqual({
      activeServerDir: '/happy/server',
      logsDir: '/happy/logs',
    });
    expect(runtimeArg?.directories).not.toHaveProperty('env');
    expect(runtimeArg?.transcripts).toEqual({
      fileFollow: runtime.transcripts.fileFollow,
    });
    expect(runtimeArg?.transcripts).not.toHaveProperty('rawClient');
    expect(runtimeArg?.external).toEqual({
      transcripts: runtime.external.transcripts,
      candidates: runtime.external.candidates,
    });
    expect(runtimeArg?.external).not.toHaveProperty('rawClient');
    expect(runtimeArg?.diagnostics).toEqual({
      issue: runtime.diagnostics.issue,
    });
    expect(runtimeArg?.diagnostics).not.toHaveProperty('hostServices');
  });

  it('maps engine takeover_not_available results to a null takeover spawn plan', async () => {
    const catalog = BackendSurfaceOperationCatalogV1;
    const backend = createBackend([
      createSurfaceHandler('externalSession', catalog.externalSession.resolveTakeoverLaunch),
    ]);
    const engine = {
      externalSessionSurface: createExternalSessionSurfaceFixture({
        resolveTakeoverLaunch: async () => ({
          ok: false as const,
          code: 'takeover_not_available' as const,
          message: 'provider has no resumable cwd',
        }),
      }),
    } satisfies BackendEngineV1;
    const diagnostics: Parameters<typeof resolveBackendExecutionSurfacesFromEngine>[0]['diagnostics'] = [];

    const surfaces = resolveBackendExecutionSurfacesFromEngine({ backend, engine, diagnostics });

    await expect(surfaces.externalSession?.resolveTakeoverSpawnOptions?.({
      linked: createLinkedSession(),
      sessionId: 'happy-session-1',
    })).resolves.toBeNull();
  });

  it('rejects malformed engine checkpoint creation requests before dispatch', async () => {
    const catalog = BackendSurfaceOperationCatalogV1;
    const backend = createBackend([
      createSurfaceHandler('checkpoint', catalog.checkpoint.checkpoint),
    ]);
    const checkpoint = vi.fn(async () => ({
      id: 'checkpoint-1',
      target: { kind: 'provider_checkpoint' as const, checkpointId: 'checkpoint-1' },
      timing: 'idle' as const,
      checkpointScopes: ['conversation' as const],
      restoreScopes: ['conversation' as const],
    }));
    const engine = {
      checkpointSurface: {
        checkpoint,
      },
    } satisfies BackendEngineV1;
    const diagnostics: Parameters<typeof resolveBackendExecutionSurfacesFromEngine>[0]['diagnostics'] = [];

    const surfaces = resolveBackendExecutionSurfacesFromEngine({ backend, engine, diagnostics });

    await expect(async () => surfaces.checkpoint?.checkpoint?.({
      sessionId: 'session-1',
      scopes: [],
      timing: 'idle',
    } as never)).rejects.toThrow(/scopes/i);
    expect(checkpoint).not.toHaveBeenCalled();
  });
});
