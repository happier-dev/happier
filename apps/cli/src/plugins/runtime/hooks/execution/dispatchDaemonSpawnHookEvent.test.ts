import { describe, expect, it, vi } from 'vitest';

import { ingestCanonicalPluginManifest } from '@/plugins/manifest/ingest';
import type { ResolvedActivatedHookRegistration } from '@/plugins/projection/registry/types';

import { dispatchDaemonSpawnHookEvent } from './dispatchDaemonSpawnHookEvent';

function createBackendPrerequisiteHookRegistration(params: Readonly<{
  pluginId: string;
  exportName: string;
  agentIdFilter?: string;
}>): ResolvedActivatedHookRegistration {
  return {
    provenance: 'external',
    source: { kind: 'path' },
    pluginId: params.pluginId,
    manifestPath: `/plugins/${params.pluginId}/plugin.json`,daemonEntryPath: `/plugins/${params.pluginId}/daemon.mjs`,
    sourceSpec: {
      kind: 'path',
      locator: `/plugins/${params.pluginId}`,
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
    },
    definition: {
      hookApiVersion: 1,
      id: 'agent.resolvePrerequisites',
      category: 'decision',
      scope: 'agent',
      executionKind: 'decide',
      ...(params.agentIdFilter ? { filters: { agentId: params.agentIdFilter } } : {}),
    },
  };
}

function createPrerequisiteHookActivationTarget(params: Readonly<{
  pluginId: string;
  agentIdFilter?: string;
}>) {
  const ingested = ingestCanonicalPluginManifest({
    schemaVersion: 2,
    id: params.pluginId,
    version: '1.0.0',
    displayName: params.pluginId,
    engines: { happier: '^0.0.0' },
    runtime: { apiVersion: 1 },
    entrypoints: { daemon: './daemon.mjs' },
    hostAccess: { required: [], optional: [] },
    contributes: {
      hooks: [{
        id: 'resolve-prerequisites',
        on: 'agent.resolvePrerequisites',
        hookApiVersion: 1,
        category: 'decision',
        scope: 'agent',
        executionKind: 'decide',
        ...(params.agentIdFilter ? { filters: { agentId: params.agentIdFilter } } : {}),
      }],
    },
  }, { sourceProvenance: 'localSource',
    manifestAuthority: params.pluginId.startsWith('happier.') ? 'bundled_first_party' : 'external',
    enforceEngineCompatibility: false,
  });
  if (!ingested.ok) throw new Error(JSON.stringify(ingested.diagnostics));
  return Object.freeze({
    provenance: 'external' as const,
    source: { kind: 'path' as const },
    pluginId: params.pluginId,
    manifestPath: `/plugins/${params.pluginId}/plugin.json`,daemonEntryPath: `/plugins/${params.pluginId}/daemon.mjs`,
    sourceSpec: {
      kind: 'path' as const,
      locator: `/plugins/${params.pluginId}`,
      trustPolicy: 'local_trusted' as const,
      installPolicy: 'link' as const,
    },
    manifest: ingested.manifest,
  });
}

describe('dispatchDaemonSpawnHookEvent', () => {
  it('dispatches through the accepted spawn runtime snapshot without resolving a parallel registry', async () => {
    const acceptedContributes = {
      agentDefinitionsById: new Map(),
            activationTargets: Object.freeze([]),
    };
    const acceptedRegistry = {
      contributes: acceptedContributes,
      hookHandlersByHookId: new Map(),
    };
    const resolveContributes = vi.fn().mockResolvedValue({
      ...acceptedContributes,
      generationId: 'stale-parallel',
    });
    const resolveRuntimeRegistry = vi.fn().mockResolvedValue({
      contributes: await resolveContributes(),
      hookHandlersByHookId: new Map(),
      dispose: vi.fn(),
    });
    resolveContributes.mockClear();
    const dispatchEvent = vi.fn().mockResolvedValue({
      eventId: 'agent.resolvePrerequisites',
      matchedHandlerCount: 0,
      outcomes: [],
      aggregate: {
        executionKind: 'decide',
        result: { decision: 'allow' },
      },
    });

    await dispatchDaemonSpawnHookEvent({
      happyHomeDir: '/tmp/happy-home',
      runtimeRegistry: acceptedRegistry,
      event: {
        eventId: 'agent.resolvePrerequisites',
        backendId: 'codex',
        backendTarget: {
          kind: 'backend',
          backendId: 'codex',
          sourceKind: 'built_in',
        },
        payload: { backendId: 'codex' },
      },
    } as never, {
      resolveContributes,
      resolveRuntimeRegistry,
      dispatchEvent,
      nowMs: () => 123,
    });

    expect(dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({
      runtimeRegistry: acceptedRegistry,
    }));
    expect(resolveContributes).not.toHaveBeenCalled();
    expect(resolveRuntimeRegistry).not.toHaveBeenCalled();
  });

  it('builds a spawn hook envelope and disposes the executable runtime registry after dispatch', async () => {
    const dispose = vi.fn().mockResolvedValue(undefined);
    const contributes = {
      agentDefinitionsById: new Map([
        [
          'codex',
          {
            id: 'codex',
            pluginId: 'happier.agent.codex',
          },
        ],
      ]),
      activationTargets: Object.freeze([]),
    };
    const resolveContributes = vi.fn().mockResolvedValue(contributes);
    const resolveRuntimeRegistry = vi.fn().mockResolvedValue({
      contributes,
      hookHandlersByHookId: new Map(),
      dispose,
    });
    const dispatchEvent = vi.fn().mockResolvedValue({
      eventId: 'agent.spawnEnv.augment',
      matchedHandlerCount: 0,
      outcomes: [],
    });

    await dispatchDaemonSpawnHookEvent({
      happyHomeDir: '/tmp/happy-home',
      event: {
        eventId: 'agent.spawnEnv.augment',
        backendId: 'codex',
        backendTarget: {
          kind: 'backend',
          backendId: 'codex',
        },
        cwd: '/repo',
        payload: {
          backendId: 'codex',
          agentId: 'codex',
          runtimeSelection: {
            codexBackendMode: 'mcp',
          },
        },
      },
    }, {
      resolveContributes,
      resolveRuntimeRegistry,
      dispatchEvent,
      nowMs: () => 123,
    });

    expect(resolveRuntimeRegistry).toHaveBeenCalledWith({
      happyHomeDir: '/tmp/happy-home',
      contributes,
      pluginIds: ['happier.agent.codex'],
    });
    expect(dispatchEvent).toHaveBeenCalledWith({
      runtimeRegistry: expect.objectContaining({
        hookHandlersByHookId: expect.any(Map),
      }),
      event: expect.objectContaining({
        hookVersion: 1,
        eventId: 'agent.spawnEnv.augment',
        category: 'augmentation',
        scope: 'daemon',
        agentId: 'codex',
        backendTarget: 'backend:codex',
        cwd: '/repo',
        timestampMs: 123,
        payload: expect.objectContaining({
          backendId: 'codex',
          agentId: 'codex',
          runtimeSelection: {
            codexBackendMode: 'mcp',
          },
          runtimeTarget: {
            kind: 'backend',
            backendId: 'codex',
          },
        }),
      }),
    });
    const dispatchedEvent = dispatchEvent.mock.calls[0]?.[0]?.event;
    expect(dispatchedEvent).not.toHaveProperty('providerId');
    expect(dispatchedEvent).not.toHaveProperty('backendId');
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('fails closed when daemon spawn hook registry acquisition exceeds the dispatch timeout', async () => {
    const resolveRuntimeRegistry = vi.fn(async () => await new Promise<never>(() => {}));
    const dispatchEvent = vi.fn();

    const result = await dispatchDaemonSpawnHookEvent({
      happyHomeDir: '/tmp/happy-home',
      event: {
        eventId: 'agent.resolvePrerequisites',
        backendId: 'codex',
        backendTarget: {
          kind: 'backend',
          backendId: 'codex',
          sourceKind: 'built_in',
        },
        cwd: '/repo',
        payload: {
          backendId: 'codex',
          targetRef: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
          timestampMs: 123,
          cwd: '/repo',
          directory: '/repo',
          runtimeSelection: {
            agentRuntimeSelection: { codexBackendMode: 'appServer' },
          },
        },
      },
    }, {
      resolveRuntimeRegistry,
      dispatchEvent,
      nowMs: () => 123,
      timeoutMs: 5,
    });

    expect(result).toMatchObject({
      eventId: 'agent.resolvePrerequisites',
      matchedHandlerCount: 1,
      outcomes: [
        expect.objectContaining({
          pluginId: 'daemon.spawn-hooks',
          hookId: 'agent.resolvePrerequisites',
          status: 'rejected',
          error: expect.stringContaining('timed out'),
        }),
      ],
      aggregate: {
        executionKind: 'decide',
        result: {
          decision: 'deny',
        },
      },
    });
    expect(dispatchEvent).not.toHaveBeenCalled();
  });

  it('resolves spawn hook runtime state only for the backend owner and matching global hooks', async () => {
    const dispose = vi.fn().mockResolvedValue(undefined);
    const globalPolicyTarget = createPrerequisiteHookActivationTarget({
      pluginId: 'acme.spawn.policy',
    });
    const ignoredTarget = createPrerequisiteHookActivationTarget({
      pluginId: 'acme.other.backend',
      agentIdFilter: 'other',
    });
    const contributes = {
      agentDefinitionsById: new Map([
        [
          'codex',
          {
            id: 'codex',
            pluginId: 'happier.agent.codex',
          },
        ],
      ]),
      activationTargets: Object.freeze([
        globalPolicyTarget,
        ignoredTarget,
      ]),
    };
    const resolveContributes = vi.fn().mockResolvedValue(contributes);
    const resolveRuntimeRegistry = vi.fn().mockResolvedValue({
      contributes,
      hookHandlersByHookId: new Map(),
      dispose,
    });
    const dispatchEvent = vi.fn().mockResolvedValue({
      eventId: 'agent.resolvePrerequisites',
      matchedHandlerCount: 0,
      outcomes: [],
      aggregate: {
        executionKind: 'decide',
        result: {
          decision: 'allow',
        },
      },
    });

    await dispatchDaemonSpawnHookEvent({
      happyHomeDir: '/tmp/happy-home',
      event: {
        eventId: 'agent.resolvePrerequisites',
        backendId: 'codex',
        backendTarget: {
          kind: 'backend',
          backendId: 'codex',
          sourceKind: 'built_in',
        },
        cwd: '/repo',
        payload: {
          backendId: 'codex',
          targetRef: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
          timestampMs: 123,
          cwd: '/repo',
          directory: '/repo',
          runtimeSelection: {
            agentRuntimeSelection: { codexBackendMode: 'appServer' },
          },
        },
      },
    }, {
      resolveContributes,
      resolveRuntimeRegistry,
      dispatchEvent,
      nowMs: () => 123,
    });

    expect(resolveRuntimeRegistry).toHaveBeenCalledWith({
      happyHomeDir: '/tmp/happy-home',
      contributes,
      pluginIds: [
        'acme.spawn.policy',
        'happier.agent.codex',
      ],
    });
    expect(dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: expect.objectContaining({
        agentId: 'codex',
      }),
    }));
    const dispatchedEvent = dispatchEvent.mock.calls[0]?.[0]?.event;
    expect(dispatchedEvent).not.toHaveProperty('providerId');
    expect(dispatchedEvent).not.toHaveProperty('backendId');
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('resolves a native Agent directly from the Agent contribution map', async () => {
    const dispose = vi.fn().mockResolvedValue(undefined);
    const activationTarget = createPrerequisiteHookActivationTarget({
      pluginId: 'happier.agent.antigravity',
      agentIdFilter: 'antigravity',
    });
    const contributes = {
      agentDefinitionsById: new Map([
        [
          'antigravity',
          {
            id: 'antigravity',
            pluginId: 'happier.agent.antigravity',
          },
        ],
      ]),
      activationTargets: Object.freeze([activationTarget]),
    };
    const resolveContributes = vi.fn().mockResolvedValue(contributes);
    const resolveRuntimeRegistry = vi.fn().mockResolvedValue({
      contributes,
      hookHandlersByHookId: new Map(),
      dispose,
    });
    const dispatchEvent = vi.fn().mockResolvedValue({
      eventId: 'agent.resolvePrerequisites',
      matchedHandlerCount: 1,
      outcomes: [{
        pluginId: 'happier.agent.antigravity',
        hookId: 'agent.resolvePrerequisites',
        status: 'fulfilled',
        result: { decision: 'allow' },
      }],
      aggregate: {
        executionKind: 'decide',
        result: { decision: 'allow' },
      },
    });
    const backendTarget = {
      kind: 'backend' as const,
      backendId: 'antigravity',
      sourceKind: 'built_in' as const,
    };

    await dispatchDaemonSpawnHookEvent({
      happyHomeDir: '/tmp/happy-home',
      event: {
        eventId: 'agent.resolvePrerequisites',
        backendId: 'antigravity',
        backendTarget,
        cwd: '/repo',
        payload: {
          backendId: 'antigravity',
          targetRef: backendTarget,
          timestampMs: 123,
          cwd: '/repo',
          directory: '/repo',
          runtimeSelection: {
            runtimeDescriptorV1: {
              v: 1,
              agentId: 'antigravity',
              agent: { runtimeMode: 'cliPrint' },
            },
          },
        },
      },
    }, {
      resolveContributes,
      resolveRuntimeRegistry,
      dispatchEvent,
      nowMs: () => 123,
    });

    expect(resolveRuntimeRegistry).toHaveBeenCalledWith({
      happyHomeDir: '/tmp/happy-home',
      contributes,
      pluginIds: ['happier.agent.antigravity'],
    });
    expect(dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: expect.objectContaining({
        agentId: 'antigravity',
        payload: expect.objectContaining({
          agentId: 'antigravity',
          runtimeTarget: backendTarget,
        }),
      }),
    }));
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
