import { describe, expect, it, vi } from 'vitest';

import type {
  AgentRuntime,
  AgentSessionRuntime,
} from '@happier-dev/plugin-sdk/agents/runtime';
import type { LoadedPlugin } from '@/plugins/discovery/load/installed';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import type {
  ResolvedAgentContribution,
  ResolvedAgentRuntimeContribution,
} from '@/plugins/projection/registry/types';
import { projectLoadedPluginContributes } from '@/plugins/projection/registry/resolvePluginContributions';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { createPluginReloadController } from '@/plugins/runtime/reload/controller';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';

import { createEmptyBackendExecutionSurfaces } from '../engineRegistryTypes';
import { resolveBackendRuntimeCore } from './runtimeCore';

function createSessionClient(sessionId: string) {
  let metadata: Record<string, unknown> = {
    path: '/tmp/runtime-currentness',
    host: 'test',
    homeDir: '/tmp',
    happyHomeDir: '/tmp/.happier',
    happyLibDir: '/tmp/.happier/lib',
    happyToolsDir: '/tmp/.happier/tools',
  };
  return {
    sessionId,
    rpcHandlerManager: {
      registerHandler: () => {},
    },
    updateAgentState: async () => {},
    updateMetadata: async (
      updater: (state: Record<string, unknown>) => Record<string, unknown>,
    ) => {
      metadata = updater(metadata);
    },
    getMetadataSnapshot: () => metadata,
    getAgentStateSnapshot: () => ({}),
    readSessionTurnsProjection: async () => null,
    on: () => {},
    off: () => {},
  };
}

function createCurrentnessRegistry(params: Readonly<{
  mediatorPluginId: string;
  materialized: boolean;
}>): ResolvedExecutablePluginRuntimeRegistry {
  const materialization = params.materialized
    ? {
      machineId: 'machine-1',
      pluginId: params.mediatorPluginId,
      materializationId: `materialization-${params.mediatorPluginId}`,
    }
    : null;
  return {
    contributes: {
      agents: [],
      actions: [],
      resources: [],
      uiViewsV2: [],
      uiRenderersV2: [],
      uiTranslationsV2: [],
      activationTargets: [],
      catalogEntriesById: {},
      agentDefinitionsById: new Map(),
      pluginDiagnosticsByPluginId: {},
    },
    pluginDiagnosticsByPluginId: {},
    resolveCurrentPluginMaterializationRef: (pluginId: string) => (
      pluginId === params.mediatorPluginId ? materialization : null
    ),
    resolveCurrentMediatorContributionMaterializationRef: (mediator: Readonly<{
      pluginId: string;
      contributionLocalId: string;
    }>) => (
      mediator.pluginId === params.mediatorPluginId
      && mediator.contributionLocalId === 'discord'
        ? materialization
        : null
    ),
    retirePluginConsumers: vi.fn(async () => undefined),
    settleRetiredBackgroundServices: vi.fn(async () => undefined),
    dispose: vi.fn(async () => undefined),
  } as unknown as ResolvedExecutablePluginRuntimeRegistry;
}

function createCurrentVoiceContributions(params: Readonly<{
  provider: Readonly<{ pluginId: string; localId: string }>;
  agent: Readonly<{ pluginId: string; localId: string }>;
}>) {
  const agentPlugin = {
    pluginId: params.agent.pluginId,
    pluginRootPath: `/plugins/${params.agent.pluginId}`,
    manifestPath: `/plugins/${params.agent.pluginId}/.happier-plugin/plugin.json`,
    daemonEntryPath: null,
    devDaemonEntryPath: null,
    sourceSpec: {
      kind: 'path',
      locator: `/plugins/${params.agent.pluginId}`,
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
    },
    manifest: normalizePluginManifestV2(createPluginManifestV2Fixture({
      id: params.agent.pluginId,
      entrypoints: {},
      contributes: {
        agents: [{
          id: params.agent.localId,
          title: 'Acme Agent',
          runtime: { kind: 'custom' },
          primary: 'sessions',
          capabilities: {
            sessions: {
              open: ['create'],
              delivery: ['newTurn'],
              cancel: true,
            },
          },
        }],
      },
    })),
  } satisfies LoadedPlugin;
  const voicePlugin = {
    pluginId: params.provider.pluginId,
    pluginRootPath: `/plugins/${params.provider.pluginId}`,
    manifestPath: `/plugins/${params.provider.pluginId}/.happier-plugin/plugin.json`,
    daemonEntryPath: null,
    devDaemonEntryPath: null,
    sourceSpec: {
      kind: 'path',
      locator: `/plugins/${params.provider.pluginId}`,
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
    },
    manifest: normalizePluginManifestV2(createPluginManifestV2Fixture({
      id: params.provider.pluginId,
      entrypoints: {},
      contributes: {
        voiceProviders: [{
          id: params.provider.localId,
          title: 'Acme Voice',
          kind: 'conversation',
          roles: ['realtime_conversation'],
          platforms: ['web'],
          capabilities: {
            turn: { cancelResponse: false, bargeIn: false },
          },
          execution: {
            kind: 'experimental_agent_session_realtime',
            agent: params.agent,
            supportedRuntimeVersions: ['1.2.3'],
          },
          settings: {
            schemaVersion: 2,
            fields: [],
            connectedServicesBinding: {
              id: 'globalConnectedServices',
              title: 'Agent account',
              agent: params.agent,
              serviceIds: ['openai-codex'],
            },
          },
          client: {
            artifactId: 'acme-voice',
            modulePath: './voice',
            exportName: 'activate',
          },
        }],
      },
    })),
  } satisfies LoadedPlugin;
  return createResolvedContributionRegistry(projectLoadedPluginContributes({
    loadResult: {
      loadedPlugins: [agentPlugin, voicePlugin],
      diagnosticsByPluginId: {},
    },
    provenance: 'external',
  }));
}

describe('resolveBackendRuntimeCore retirement signal ownership', () => {
  it('uses the reload controller live materialization owner for a Session plan across disable and re-enable', async () => {
    const pluginId = 'acme.session-agent';
    const mediatorPluginId = 'happier.channels';
    const initialRegistry = createCurrentnessRegistry({
      mediatorPluginId,
      materialized: true,
    });
    const controller = createPluginReloadController({
      resolveRuntimeRegistry: async () => initialRegistry,
    });
    const runtimeRegistryLease = await controller.acquireRuntimeRegistry();
    const backend = {
      id: pluginId,
      agentId: pluginId,
      provenance: 'external',
      source: { kind: 'path' },
      definition: { kindVersion: 1, id: pluginId, agentId: pluginId },
      pluginId,
    } as unknown as ResolvedAgentRuntimeContribution;
    const agent = {
      id: pluginId,
      identity: { pluginId, localId: pluginId },
      provenance: 'external',
      source: { kind: 'path' },
      definition: { kindVersion: 1, id: pluginId, ownedBackendIds: [pluginId] },
      richDefinition: {
        provenance: 'external',
        definition: {
          id: pluginId,
          title: { key: 'agents.acme.title', fallback: 'Acme' },
          description: { key: 'agents.acme.description', fallback: 'Acme' },
          runtime: { kind: 'custom' },
          primary: 'sessions',
          capabilities: {
            sessions: {
              open: ['create'],
              delivery: ['newTurn'],
              cancel: true,
            },
          },
        },
      },
      pluginId,
    } as unknown as ResolvedAgentContribution;

    try {
      const adapter = await resolveBackendRuntimeCore({
        backend,
        agent,
        executionSurfaces: createEmptyBackendExecutionSurfaces(),
        runtimeOwner: {
          backendId: pluginId,
          selected: {
            kind: 'plugin_engine',
            ownerId: pluginId,
            provenance: 'external',
            pluginId,
          },
          candidates: [],
        },
        runtimeRegistry: runtimeRegistryLease.registry,
        // The engine registry will supply this canonical reload-controller
        // resolver. Cast while RED because the runtime-core contract does not
        // expose it yet.
        resolveCurrentPluginMaterializationRef:
          runtimeRegistryLease.resolveCurrentPluginMaterializationRef,
        resolveCurrentMediatorContributionMaterializationRef: (
          runtimeRegistryLease as unknown as Readonly<{
            resolveCurrentMediatorContributionMaterializationRef: (
              mediator: Readonly<{ pluginId: string; contributionLocalId: string }>,
            ) => unknown;
          }>
        ).resolveCurrentMediatorContributionMaterializationRef,
        nativeAgentRuntime: {
          sessions: {
            open: vi.fn(),
          },
        } as unknown as AgentRuntime,
        nativeAgentRuntimeIdentity: {
          pluginId,
          pluginVersion: '1.0.0',
          agentId: pluginId,
          generation: 'agent-generation',
          isCurrent: () => true,
        },
      } as never);
      const plan = await adapter?.runtimeCore.createSessionRuntime({
        credentials: {
          token: 'test-token',
          encryption: {
            type: 'legacy',
            secret: new Uint8Array([1, 2, 3]),
          },
        },
        directory: '/tmp/runtime-currentness',
        backendTarget: { kind: 'backend', backendId: pluginId },
      });
      if (!plan || !('config' in plan)) {
        throw new Error('Expected native Agent host session plan');
      }
      const isMediatorContributionCurrent = (
        plan.config as typeof plan.config & Readonly<{
          isMediatorContributionCurrent?: (mediator: Readonly<{
            pluginId: string;
            contributionLocalId: string;
          }>) => boolean;
        }>
      ).isMediatorContributionCurrent;
      expect(isMediatorContributionCurrent?.({
        pluginId: mediatorPluginId,
        contributionLocalId: 'discord',
      })).toBe(true);
      expect(isMediatorContributionCurrent?.({
        pluginId: mediatorPluginId,
        contributionLocalId: 'other-contribution',
      })).toBe(false);

      await controller.adoptPreparedRuntimeRegistry({
        registry: createCurrentnessRegistry({ mediatorPluginId, materialized: false }),
        changedPluginIds: [mediatorPluginId],
        durableRevision: 1,
        runningSessionDisposition: 'retainRunningSessions',
      });
      expect(isMediatorContributionCurrent?.({
        pluginId: mediatorPluginId,
        contributionLocalId: 'discord',
      })).toBe(false);

      await controller.adoptPreparedRuntimeRegistry({
        registry: createCurrentnessRegistry({ mediatorPluginId, materialized: true }),
        changedPluginIds: [mediatorPluginId],
        durableRevision: 2,
        runningSessionDisposition: 'retainRunningSessions',
      });
      expect(isMediatorContributionCurrent?.({
        pluginId: mediatorPluginId,
        contributionLocalId: 'discord',
      })).toBe(true);
    } finally {
      await runtimeRegistryLease.release();
      await controller.shutdown({ timeoutMs: 0 });
    }
  });

  it('uses exact registered Agent generations without substituting registry-wide retirement', async () => {
    const agentId = 'generation-agent';
    const backendId = agentId;
    const pluginId = 'acme.carried-plugin';
    const backend = {
      id: backendId,
      agentId,
      provenance: 'external',
      source: { kind: 'path' },
      definition: { kindVersion: 1, id: backendId, agentId },
      pluginId,
    } as unknown as ResolvedAgentRuntimeContribution;
    const agent = {
      id: agentId,
      identity: { pluginId, localId: agentId },
      provenance: 'external',
      source: { kind: 'path' },
      definition: { kindVersion: 1, id: agentId, ownedBackendIds: [backendId] },
      richDefinition: {
        provenance: 'external',
        definition: {
          id: agentId,
          title: { key: 'agents.acme.title', fallback: 'Acme' },
          description: { key: 'agents.acme.description', fallback: 'Acme' },
          runtime: { kind: 'custom' },
          primary: 'sessions',
          capabilities: {
            sessions: {
              open: ['create'],
              delivery: ['newTurn'],
              cancel: true,
            },
          },
        },
      },
      pluginId,
    } as unknown as ResolvedAgentContribution;
    const registryRetirement = new AbortController();
    const agentGenerationRetirement = new AbortController();
    const voiceRetirement = new AbortController();
    const voiceProvider = {
      pluginId: 'acme.voice',
      localId: 'conversation',
    } as const;
    const contributes = createCurrentVoiceContributions({
      provider: voiceProvider,
      agent: { pluginId, localId: agentId },
    });
    const runtimeRegistry = {
      contributes,
      retirementSignal: registryRetirement.signal,
      resolveVoiceProviderRuntimeLifecycle: () => ({
        generation: 'voice-generation',
        isCurrent: () => !voiceRetirement.signal.aborted,
        retirementSignal: voiceRetirement.signal,
      }),
    } as unknown as ResolvedExecutablePluginRuntimeRegistry;
    const session: AgentSessionRuntime = {
      send: vi.fn(async () => ({ status: 'admitted' as const })),
      watch: () => ({ dispose: () => {} }),
      dispose: vi.fn(async () => {}),
    };
    const open = vi.fn(async () => session);
    const runtime: AgentRuntime = {
      sessions: { open },
    };
    const adapter = await resolveBackendRuntimeCore({
      backend,
      agent,
      executionSurfaces: createEmptyBackendExecutionSurfaces(),
      runtimeOwner: {
        backendId,
        selected: {
          kind: 'plugin_engine',
          ownerId: pluginId,
          provenance: 'external',
          pluginId,
        },
        candidates: [],
      },
      runtimeRegistry,
      nativeAgentRuntime: runtime,
      nativeAgentRuntimeIdentity: {
        pluginId,
        pluginVersion: '1.0.0',
        agentId,
        generation: 'agent-generation',
        retirementSignal: agentGenerationRetirement.signal,
        isCurrent: () => true,
      },
    });
    const plan = await adapter?.runtimeCore.createSessionRuntime({
      credentials: {
        token: 'test-token',
        encryption: {
          type: 'legacy',
          secret: new Uint8Array([1, 2, 3]),
        },
      },
      directory: '/tmp/runtime-currentness',
      backendTarget: { kind: 'backend', backendId },
    });
    if (!plan || !('config' in plan) || !plan.config.createSessionRuntime) {
      throw new Error('Expected native Agent host session plan');
    }
    const voiceAuthority = plan.config.agentSessionRealtimeVoiceAuthority;
    expect(plan.config).not.toHaveProperty(
      'daemonAgentRuntimeCarrierRetirementSignal',
    );
    expect(voiceAuthority?.resolveDeclaration(voiceProvider)?.id).toBe(
      voiceProvider.localId,
    );
    expect(voiceAuthority?.resolveProviderGeneration(voiceProvider)).toBe(
      'voice-generation',
    );
    expect(voiceAuthority?.isCurrent(voiceProvider)).toBe(true);

    registryRetirement.abort(new Error('unrelated registry retirement'));
    expect(voiceAuthority?.isCurrent(voiceProvider)).toBe(true);
    const created = await plan.config.createSessionRuntime({
      directory: '/tmp/runtime-currentness',
      metadata: {},
      machineId: 'machine-1',
      session: createSessionClient('session-currentness'),
      transcriptSession: {},
      messageBuffer: {},
      mcpServers: {},
      permissionHandler: {},
      getPermissionMode: () => 'default',
      setThinking: () => {},
      memoryRecallGuidanceEnabled: false,
    } as never);

    expect(open).toHaveBeenCalledTimes(1);
    await created.operations.resetOrDisposeRuntime();

    const carriedOnlyAdapter = await resolveBackendRuntimeCore({
      backend,
      agent,
      executionSurfaces: createEmptyBackendExecutionSurfaces(),
      runtimeOwner: {
        backendId,
        selected: {
          kind: 'plugin_engine',
          ownerId: pluginId,
          provenance: 'external',
          pluginId,
        },
        candidates: [],
      },
      runtimeRegistry: null,
      nativeAgentRuntimeVoiceAuthority: voiceAuthority,
      nativeAgentRuntime: runtime,
      nativeAgentRuntimeIdentity: {
        pluginId,
        pluginVersion: '1.0.0',
        agentId,
        generation: 'agent-generation',
        retirementSignal: agentGenerationRetirement.signal,
        isCurrent: () =>
          !agentGenerationRetirement.signal.aborted,
      },
    });
    const carriedOnlyPlan =
      await carriedOnlyAdapter?.runtimeCore.createSessionRuntime({
        credentials: {
          token: 'test-token',
          encryption: {
            type: 'legacy',
            secret: new Uint8Array([1, 2, 3]),
          },
        },
        directory: '/tmp/runtime-currentness',
        backendTarget: { kind: 'backend', backendId },
      });
    const carriedOnlyAuthority =
      carriedOnlyPlan && 'config' in carriedOnlyPlan
        ? carriedOnlyPlan.config.agentSessionRealtimeVoiceAuthority
        : null;
    expect(carriedOnlyAuthority?.resolveDeclaration(voiceProvider)?.id).toBe(
      voiceProvider.localId,
    );
    expect(
      carriedOnlyAuthority?.resolveProviderGeneration(voiceProvider),
    ).toBe('voice-generation');
    expect(carriedOnlyAuthority?.isCurrent(voiceProvider)).toBe(true);
    agentGenerationRetirement.abort(
      new Error('Agent generation retired'),
    );
    expect(carriedOnlyAuthority?.isCurrent(voiceProvider)).toBe(false);
  });
});
