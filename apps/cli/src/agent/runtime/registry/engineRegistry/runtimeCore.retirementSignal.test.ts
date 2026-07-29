import { describe, expect, it, vi } from 'vitest';

import type {
  AgentRuntime,
  AgentSessionRuntime,
} from '@happier-dev/plugin-sdk/agent-runtime';
import type {
  ResolvedAgentContribution,
  ResolvedAgentRuntimeContribution,
} from '@/plugins/projection/registry/types';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';

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

describe('resolveBackendRuntimeCore retirement signal ownership', () => {
  it('uses exact registry or carried declaration generations without substituting registry-wide retirement', async () => {
    const agentId = 'acme.carried-agent';
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
    const carrierRetirement = new AbortController();
    const voiceRetirement = new AbortController();
    const voiceProvider = {
      pluginId: 'acme.voice',
      localId: 'conversation',
    } as const;
    const runtimeRegistry = {
      contributes: {
        agents: [],
        voiceProviders: [{
          pluginId: voiceProvider.pluginId,
          identity: voiceProvider,
          manifestDigest: 'manifest:acme-voice',
          definition: {
            id: voiceProvider.localId,
            title: 'Acme Voice',
            kind: 'conversation',
            roles: ['realtime_conversation'],
            platforms: ['web'],
            capabilities: {
              readiness: { requirements: [] },
              turn: { cancelResponse: false, bargeIn: false },
            },
            execution: {
              kind: 'experimental_agent_session_realtime',
              agent: { pluginId, localId: agentId },
            },
            client: {
              artifactId: 'acme-voice',
              modulePath: './voice',
              exportName: 'activate',
            },
          },
        }],
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
      retirementSignal: registryRetirement.signal,
      resolveContributionRuntimeLifecycle: () => ({
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
        generation: 'carrier-generation',
        retirementSignal: carrierRetirement.signal,
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
    expect(plan.config.daemonAgentRuntimeCarrierRetirementSignal).toBe(
      carrierRetirement.signal,
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
        generation: 'carrier-generation',
        retirementSignal: carrierRetirement.signal,
        isCurrent: () => !carrierRetirement.signal.aborted,
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
    carrierRetirement.abort(new Error('carrier retired'));
    expect(carriedOnlyAuthority?.isCurrent(voiceProvider)).toBe(false);
  });
});
