import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PROVIDER_SETTINGS_V1,
  ProviderConnectionIdSchema,
  ProviderContributionV1Schema,
} from '@happier-dev/protocol';

import type { TrackedSession } from '@/daemon/types';
import type { ResolvedProviderContribution } from '@/plugins/projection/registry/types';
import type { AgentRuntimeRegistrationLease } from '@/plugins/runtime/lifecycle/contributions/targetAgents';
import type { ProviderContributionRegistryView } from '@/providers/registry';

import { resolveTrackedRunnerAgentRuntimeCurrentness } from './resolveAgentRuntimeCurrentness';

const SELECTED_PROVIDER_CONNECTION_ID =
  ProviderConnectionIdSchema.parse('pc_gateway');

function tracked(overrides: Partial<TrackedSession> = {}): TrackedSession {
  return {
    startedBy: 'daemon',
    pid: 123,
    runnerAgentImmutableGenerationId: 'generation-g',
    spawnOptions: {
      directory: '/work',
      backendTarget: {
        kind: 'backend',
        backendId: 'codex',
        sourceKind: 'built_in',
      },
    },
    ...overrides,
  };
}

function registration(input: Readonly<{
  generation?: string | null;
  hasPrimaryRuntime?: boolean;
  isCurrent?: () => boolean;
}> = {}): AgentRuntimeRegistrationLease {
  const base = {
    pluginId: 'happier.agent.codex',
    pluginVersion: '1.0.0',
    agentId: 'codex',
    localAgentId: 'codex',
    generation: 'registry-generation',
    immutableGenerationId:
      'generation' in input ? input.generation : 'generation-g',
    retirementSignal: new AbortController().signal,
    isCurrent: input.isCurrent ?? (() => true),
    createAgentRuntimeSurfaceInvocationContext: async () => {
      throw new Error('not used by currentness tests');
    },
  };
  if (input.hasPrimaryRuntime === false) {
    return { ...base, hasPrimaryRuntime: false };
  }
  return {
    ...base,
    hasPrimaryRuntime: true,
    createRuntime: async () => {
      throw new Error('not used by currentness tests');
    },
  };
}

function providerContribution(): ResolvedProviderContribution {
  return {
    provenance: 'external',
    source: { kind: 'path' },
    pluginId: 'acme.gateway',
    identity: {
      pluginId: 'acme.gateway',
      localId: 'gateway',
    },
    definition: ProviderContributionV1Schema.parse({
      v: 1,
      id: 'gateway',
      name: 'Gateway',
      kind: 'cloud',
      endpointTemplates: [{
        id: 'responses',
        protocol: 'openai-responses',
        baseUrl: 'https://gateway.example/v1',
        capabilities: {
          streaming: 'supported',
          toolRoundTrips: 'unknown',
          statefulResponses: 'unknown',
          reasoningControls: 'unknown',
        },
      }],
      catalog: {
        source: 'manual',
        manualModelPolicy: 'allowed',
      },
    }),
  };
}

function selectedProviderTracked(): TrackedSession {
  return tracked({
    spawnOptions: {
      directory: '/work',
      backendTarget: {
        kind: 'backend',
        backendId: 'codex',
        sourceKind: 'built_in',
      },
      modelSelection: {
        v: 1,
        updatedAt: 1,
        ref: {
          agentTargetKey: 'backend:codex',
          providerConnectionId: SELECTED_PROVIDER_CONNECTION_ID,
          modelId: 'model-p',
        },
      },
    },
  });
}

function providerResolution(
  registry: ProviderContributionRegistryView,
) {
  return {
    machineId: 'machine-a',
    accountSettings: {
      providerSettingsV1: {
        ...DEFAULT_PROVIDER_SETTINGS_V1,
        connections: [{
          v: 1 as const,
          id: SELECTED_PROVIDER_CONNECTION_ID,
          source: {
            kind: 'contribution' as const,
            contributionKey: 'acme.gateway/gateway',
          },
          role: 'default' as const,
          displayName: 'Gateway',
          displayNameMode: 'automatic' as const,
          deployment: { kind: 'external' as const },
          revision: 1,
          createdAt: 1,
          updatedAt: 1,
        }],
      },
    },
    registry,
  };
}

describe('resolveTrackedRunnerAgentRuntimeCurrentness', () => {
  it.each([
    ['generation-g', 'current'],
    ['generation-h', 'stale'],
  ] as const)('compares pinned G with authoritative generation %s', (generation, expected) => {
    expect(resolveTrackedRunnerAgentRuntimeCurrentness({
      tracked: tracked(),
      agentRuntimesByAgentId: new Map([
        ['codex', registration({ generation })],
      ]),
    })).toEqual({
      versionState: expected,
      restartUnavailableReason: null,
    });
  });

  it('returns unknown when private pinned or authoritative evidence is unverifiable', () => {
    expect(resolveTrackedRunnerAgentRuntimeCurrentness({
      tracked: tracked({ runnerAgentImmutableGenerationId: undefined }),
      agentRuntimesByAgentId: new Map([
        ['codex', registration()],
      ]),
    }).versionState).toBe('unknown');
    expect(resolveTrackedRunnerAgentRuntimeCurrentness({
      tracked: tracked(),
      agentRuntimesByAgentId: new Map([
        ['codex', registration({ generation: null })],
      ]),
    }).versionState).toBe('unknown');
    expect(resolveTrackedRunnerAgentRuntimeCurrentness({
      tracked: tracked(),
      agentRuntimesByAgentId: new Map([
        ['codex', registration({ isCurrent: () => false })],
      ]),
    }).versionState).toBe('unknown');
  });

  it('marks a removed or no-longer-session-capable contribution stale but not restartable', () => {
    expect(resolveTrackedRunnerAgentRuntimeCurrentness({
      tracked: tracked(),
      agentRuntimesByAgentId: new Map(),
    })).toEqual({
      versionState: 'stale',
      restartUnavailableReason: 'unsupported_backend',
    });
    expect(resolveTrackedRunnerAgentRuntimeCurrentness({
      tracked: tracked(),
      agentRuntimesByAgentId: new Map([
        ['codex', registration({ hasPrimaryRuntime: false })],
      ]),
    })).toEqual({
      versionState: 'stale',
      restartUnavailableReason: 'unsupported_backend',
    });
  });

  it('does not project a hard-revoked surviving runner as optional stale code', () => {
    expect(resolveTrackedRunnerAgentRuntimeCurrentness({
      tracked: tracked({
        agentRuntimeRunnerRestartDisposition:
          'runner_authority_unavailable',
      }),
      agentRuntimesByAgentId: new Map(),
    })).toEqual({
      versionState: 'unknown',
      restartUnavailableReason: 'unsupported_backend',
    });
  });

  it('marks a current Agent stale and not restartable when its selected Provider contribution was removed', () => {
    expect(resolveTrackedRunnerAgentRuntimeCurrentness({
      tracked: selectedProviderTracked(),
      agentRuntimesByAgentId: new Map([
        ['codex', registration()],
      ]),
      providerResolution: providerResolution({
        providersByContributionKey: new Map(),
      }),
    })).toEqual({
      versionState: 'stale',
      restartUnavailableReason: 'unsupported_backend',
    });
  });

  it('keeps a current Agent with a resolvable selected Provider current', () => {
    expect(resolveTrackedRunnerAgentRuntimeCurrentness({
      tracked: selectedProviderTracked(),
      agentRuntimesByAgentId: new Map([
        ['codex', registration()],
      ]),
      providerResolution: providerResolution({
        providersByContributionKey: new Map([
          ['acme.gateway/gateway', providerContribution()],
        ]),
      }),
    })).toEqual({
      versionState: 'current',
      restartUnavailableReason: null,
    });
  });
});
