import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeOutboundTranscriptDispatchFacetV1 } from '@happier-dev/agents';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';

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
    sendTurnPrompt: vi.fn(async () => undefined),
    steerInFlightTurn: vi.fn(async () => undefined),
    waitForTurnCompletion: vi.fn(async () => undefined),
    subscribeRuntimeEvents: vi.fn(() => () => undefined),
    cancelTurn: vi.fn(async () => undefined),
    readSessionIdentity: vi.fn(() => ({ sessionId: 'session-1' })),
    updateSessionRuntimeConfig: vi.fn(async () => undefined),
    resetOrDisposeRuntime: vi.fn(async () => undefined),
  };
}

const cliSourceRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const bridgeOnlyExecutionSurfaceRoots = [
  'api',
  'session',
  'terminal',
  'agent/terminalRuntime',
] as const;
const forbiddenExecutionSurfaceResolvers = [
  'resolveBackendExecutionSurfaces',
  'resolveBackendEngineAdapterResolution',
  'resolveCliEngineRegistry',
] as const;
const retiredProcessGlobalExternalSessionHostOperationSymbols = [
  'installExternalSessionFollowHostOperation',
  'readExternalSessionFollowHostOperation',
  'installExternalSessionTakeoverHostOperation',
  'readExternalSessionTakeoverHostOperation',
] as const;

async function listProductionTypeScriptFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const entryPath = join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__') return [];
      return listProductionTypeScriptFiles(entryPath);
    }
    if (!entry.isFile() || !entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) {
      return [];
    }
    return [entryPath];
  }));
  return files.flat();
}

function parseImportStatements(source: string): Array<{ statement: string; specifier: string }> {
  const imports: Array<{ statement: string; specifier: string }> = [];
  const importPattern = /import\s+[\s\S]*?\s+from\s+['"]([^'"]+)['"];?/gu;
  let match: RegExpExecArray | null;
  while ((match = importPattern.exec(source)) !== null) {
    imports.push({ statement: match[0], specifier: match[1] ?? '' });
  }
  return imports;
}

function isEngineRegistrySpecifier(specifier: string): boolean {
  return specifier === '@/agent/runtime/registry/engineRegistry'
    || specifier.endsWith('/agent/runtime/registry/engineRegistry')
    || specifier.endsWith('/registry/engineRegistry');
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

  it('resolves outbound transcript dispatch facets through the requested backend engine adapter', async () => {
    const facet: RuntimeOutboundTranscriptDispatchFacetV1 = {
      prepareDispatch: vi.fn(),
    };
    resolveBackendEngineAdapterResolutionMock.mockResolvedValue({
      engineAdapter: {
        facets: {
          transcriptDispatch: facet,
        },
      },
    });

    const bridge = new SessionHostBridge();

    await expect(bridge.resolveOutboundTranscriptDispatchFacet(' acme.sample.backend ')).resolves.toEqual({
      backendId: 'acme.sample.backend',
      facet,
    });
    expect(resolveBackendEngineAdapterResolutionMock).toHaveBeenCalledWith('acme.sample.backend');
  });

  it('does not resolve an outbound transcript dispatch facet without a backend id or facet', async () => {
    const bridge = new SessionHostBridge();

    await expect(bridge.resolveOutboundTranscriptDispatchFacet('  ')).resolves.toBeNull();
    expect(resolveBackendEngineAdapterResolutionMock).not.toHaveBeenCalled();

    resolveBackendEngineAdapterResolutionMock.mockResolvedValue({
      engineAdapter: {
        facets: {},
      },
    });

    await expect(bridge.resolveOutboundTranscriptDispatchFacet('acme.sample.backend')).resolves.toBeNull();
    expect(resolveBackendEngineAdapterResolutionMock).toHaveBeenCalledWith('acme.sample.backend');
  });

  it('evaluates attach eligibility with bridge-owned backend execution surface resolution', async () => {
    const attach = {
      evaluateAvailability: vi.fn(async ({ metadata }: { metadata: Record<string, unknown> }) => ({
        eligible: true as const,
        scope: 'remote' as const,
        metadata,
      })),
      probeReachability: vi.fn(async () => ({ reachable: true as const })),
      attach: vi.fn(async () => 0),
    };
    resolveBackendExecutionSurfacesMock.mockResolvedValue({
      terminalRuntime: null,
      externalSession: null,
      attach,
      handoff: null,
      fork: null,
      checkpoint: null,
    });

    const bridge = new SessionHostBridge();

    await expect(bridge.evaluateAttachEligibility({
      credentials: {
        token: 'token-1',
        encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
      },
      rawSession: createSessionRecordFixture({
        id: 'session-1',
        active: true,
        encryptionMode: 'plain',
        metadata: JSON.stringify({
          machineId: 'machine-remote',
          flavor: 'opencode',
          opencodeSessionId: 'opencode-session-1',
          opencodeBackendMode: 'server',
        }),
      }),
      currentMachineId: 'machine-local',
      localAttachmentInfo: null,
      insideTmux: false,
    })).resolves.toMatchObject({
      eligible: true,
      attachStrategy: 'provider_attach',
      backendId: 'opencode',
      attachScope: 'remote',
    });
    expect(resolveBackendExecutionSurfacesMock).toHaveBeenCalledWith('opencode');
    expect(attach.evaluateAvailability).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-1',
    }));
  });

  it('keeps session, api, and terminal control paths behind the session host bridge for engine execution surfaces', async () => {
    const violations: string[] = [];

    for (const root of bridgeOnlyExecutionSurfaceRoots) {
      const files = await listProductionTypeScriptFiles(join(cliSourceRoot, root));
      for (const file of files) {
        const source = await readFile(file, 'utf8');
        for (const importStatement of parseImportStatements(source)) {
          if (
            importStatement.statement.startsWith('import type')
            || !isEngineRegistrySpecifier(importStatement.specifier)
          ) {
            continue;
          }
          const importedForbiddenResolver = forbiddenExecutionSurfaceResolvers.find((resolver) => (
            importStatement.statement.includes(resolver)
          ));
          if (importedForbiddenResolver) {
            violations.push(`${relative(cliSourceRoot, file)} imports ${importedForbiddenResolver}`);
          }
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('keeps External Session host operations out of process-global installation stacks', async () => {
    const violations: string[] = [];
    const files = await listProductionTypeScriptFiles(cliSourceRoot);

    for (const file of files) {
      const source = await readFile(file, 'utf8');
      for (const symbol of retiredProcessGlobalExternalSessionHostOperationSymbols) {
        if (source.includes(symbol)) {
          violations.push(`${relative(cliSourceRoot, file)} contains ${symbol}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('creates a canonical host session plan through runtimeCore for the requested backend', async () => {
    const createdPlan = {
      kind: 'hostSessionRuntimePlan',
      agentId: 'acme.sample.backend',
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
      agentId: 'acme.sample.backend',
      opts: { marker: 'created-plan' },
      config: {
        createSessionRuntime: createPlanRuntime,
      },
    };
    const createSessionRuntime = vi.fn(async (_params: unknown) => createdPlan);
    resolveBackendEngineAdapterResolutionMock.mockResolvedValue({
      backendId: 'acme.sample.backend',
      agentId: 'acme.sample.provider',
      provenance: 'external',
      diagnostics: [],
      backend: {
        id: 'acme.sample.backend',
        agentId: 'acme.sample.provider',
        runtimeKind: 'native',
        capabilities: {
          sessions: { supported: true },
        },
      },
      agent: {
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

    unsubscribe();

    expect(messages).toEqual([
      {
        type: 'event',
        name: 'runtime.descriptor',
        payload: {
          v: 1,
          agentId: 'acme.sample.provider',
          agent: {
            backendMode: 'native',
            providerSessionId: 'session-1',
            agentExtra: {
              owner: 'happier',
              schemaId: 'happier.hostSessionRuntimeIdentity',
              v: 1,
              runtimeHandle: {
                backendId: 'acme.sample.backend',
                agentId: 'acme.sample.provider',
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
      agentId: 'acme.sample.backend',
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

  it('threads a daemon-control local-services runtime into daemon-spawned plugin session resolution', async () => {
    const createdPlan = {
      kind: 'hostSessionRuntimePlan',
      agentId: 'acme.sample.backend',
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
      startedBy: 'daemon',
    })).resolves.toEqual(createdPlan);
    expect(resolveBackendEngineAdapterResolutionMock).toHaveBeenCalledWith('acme.sample.backend', {
      happyHomeDir: '/tmp/happy-home',
      localServicesRuntime: expect.objectContaining({
        createPluginLocalServicesBridge: expect.any(Function),
      }),
      requireDaemonAgentRuntimeCarrier: true,
    });
    expect(createSessionRuntime).toHaveBeenCalledWith({
      cwd: '/tmp/session',
      happyHomeDir: '/tmp/happy-home',
      startedBy: 'daemon',
    });
  });

  it('threads the matching daemon token-file runtime carrier through the child session entrypoint', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-session-host-carrier-'));
    const tokenFilePath = join(root, 'carrier.json');
    const envKey = 'HAPPIER_AGENT_RUNTIME_DAEMON_BRIDGE_TOKEN_FILE';
    const previousTokenFilePath = process.env[envKey];
    const descriptor = {
      v: 1 as const,
      pluginId: 'happier.agent.acme',
      pluginVersion: '1.0.0',
      agentId: 'acme',
      backendId: 'acme.sample.backend',
      generation: 'generation-1',
      runtimeAuthority: {
        permissions: ['session.hooks.control'],
        runtimeCapabilities: ['sessionHooks'],
      },
      runtimeSurfaces: {
        terminal: true,
      },
      factoryControls: {
        continuation: false,
        goals: false,
        catalog: false,
        usageLimitRecovery: false,
      },
    };
    await writeFile(tokenFilePath, `${JSON.stringify({
      v: 1,
      token: 'child-private-token',
      descriptor,
    })}\n`, 'utf8');
    process.env[envKey] = tokenFilePath;

    const createdPlan = {
      kind: 'hostSessionRuntimePlan',
      agentId: descriptor.agentId,
      opts: { cwd: '/tmp/session' },
      config: {},
    };
    resolveBackendEngineAdapterResolutionMock.mockResolvedValue({
      provenance: 'first_party',
      diagnostics: [],
      engineAdapter: {
        runtimeCore: {
          createSessionRuntime: vi.fn(async () => createdPlan),
        },
      },
    });

    try {
      const bridge = new SessionHostBridge();
      await expect(bridge.createSessionRuntime(descriptor.backendId, {
        cwd: '/tmp/session',
        startedBy: 'daemon',
      })).resolves.toEqual(createdPlan);
      expect(resolveBackendEngineAdapterResolutionMock).toHaveBeenCalledWith(
        descriptor.backendId,
        expect.objectContaining({
          requireDaemonAgentRuntimeCarrier: true,
          nativeAgentRuntimeCarrier: expect.objectContaining({
            descriptor,
            runtime: expect.objectContaining({
              sessions: expect.objectContaining({ open: expect.any(Function) }),
              surfaces: {
                terminal: {
                  resolveLaunch: expect.any(Function),
                },
              },
            }),
            externalSessionHostOperations: expect.objectContaining({
              bindSession: expect.any(Function),
            }),
            isCurrent: expect.any(Function),
          }),
        }),
      );
    } finally {
      if (previousTokenFilePath === undefined) delete process.env[envKey];
      else process.env[envKey] = previousTokenFilePath;
      await rm(root, { recursive: true, force: true });
    }
  });

  it('threads an admitted foreground token-file runtime carrier without changing terminal session params', async () => {
    const root = await mkdtemp(
      join(tmpdir(), 'happier-session-host-foreground-carrier-'),
    );
    const tokenFilePath = join(root, 'carrier.json');
    const descriptor = {
      v: 1 as const,
      pluginId: 'happier.agent.acme',
      pluginVersion: '1.0.0',
      agentId: 'acme',
      backendId: 'acme.sample.backend',
      generation: 'generation-1',
      runtimeAuthority: {
        permissions: ['session.hooks.control'],
        runtimeCapabilities: ['sessionHooks'],
      },
      runtimeSurfaces: {
        terminal: true,
      },
      factoryControls: {
        continuation: false,
        goals: false,
        catalog: false,
        usageLimitRecovery: false,
      },
    };
    await writeFile(tokenFilePath, `${JSON.stringify({
      v: 1,
      token: 'foreground-private-token',
      descriptor,
    })}\n`, 'utf8');
    const sessionParams = {
      cwd: '/tmp/session',
      startedBy: 'terminal',
      resume: 'agent-session-1',
    };
    const createdPlan = {
      kind: 'hostSessionRuntimePlan',
      agentId: descriptor.agentId,
      opts: sessionParams,
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

    try {
      const bridge = new SessionHostBridge();
      await expect(bridge.runSessionCommand(
        descriptor.backendId,
        sessionParams,
        {
          agentRuntimeDaemonBridgeTokenFilePath: tokenFilePath,
        },
      )).resolves.toBeUndefined();
      expect(resolveBackendEngineAdapterResolutionMock).toHaveBeenCalledWith(
        descriptor.backendId,
        expect.objectContaining({
          requireDaemonAgentRuntimeCarrier: true,
          nativeAgentRuntimeCarrier: expect.objectContaining({
            descriptor,
            runtime: expect.objectContaining({
              sessions: expect.objectContaining({ open: expect.any(Function) }),
            }),
          }),
        }),
      );
      expect(runHostSessionRuntimePlanMock).toHaveBeenCalledWith(
        expect.objectContaining({
          deps: expect.objectContaining({
            sessionLoopLifecycleDeps: expect.objectContaining({
              daemonTurnContributionsBridge: expect.objectContaining({
                resolvePrompt: expect.any(Function),
                transformAgentContext: expect.any(Function),
                transformSessionInput: expect.any(Function),
              }),
            }),
          }),
        }),
      );
      expect(createSessionRuntime).toHaveBeenCalledWith(sessionParams);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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
      agentId: 'acme.sample.backend',
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

  it('runs final commit revalidation after plan construction and before runtime execution', async () => {
    const events: string[] = [];
    const createdPlan = {
      kind: 'hostSessionRuntimePlan',
      agentId: 'acme.sample.backend',
      opts: { cwd: '/tmp/session' },
      config: {},
    };
    resolveBackendEngineAdapterResolutionMock.mockResolvedValue({
      provenance: 'first_party',
      diagnostics: [],
      engineAdapter: {
        runtimeCore: {
          createSessionRuntime: async () => {
            events.push('plan-created');
            return createdPlan;
          },
        },
      },
    });
    runHostSessionRuntimePlanMock.mockImplementation(async () => {
      events.push('runtime-started');
    });
    const bridge = new SessionHostBridge();

    await bridge.runSessionCommand(
      'acme.sample.backend',
      { cwd: '/tmp/session' },
      {
        beforeRuntimePlanCommit: async () => {
          events.push('commit-revalidated');
        },
      },
    );

    expect(events).toEqual(['plan-created', 'commit-revalidated', 'runtime-started']);
  });

  it('does not execute a runtime plan when final commit revalidation refuses', async () => {
    const createdPlan = {
      kind: 'hostSessionRuntimePlan',
      agentId: 'acme.sample.backend',
      opts: { cwd: '/tmp/session' },
      config: {},
    };
    resolveBackendEngineAdapterResolutionMock.mockResolvedValue({
      provenance: 'first_party',
      diagnostics: [],
      engineAdapter: {
        runtimeCore: { createSessionRuntime: async () => createdPlan },
      },
    });
    const bridge = new SessionHostBridge();

    await expect(bridge.runSessionCommand(
      'acme.sample.backend',
      { cwd: '/tmp/session' },
      { beforeRuntimePlanCommit: async () => { throw new Error('authorization changed'); } },
    )).rejects.toThrow('authorization changed');
    expect(runHostSessionRuntimePlanMock).not.toHaveBeenCalled();
  });
});
