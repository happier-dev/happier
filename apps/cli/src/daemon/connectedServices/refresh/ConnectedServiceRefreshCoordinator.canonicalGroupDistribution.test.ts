import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ConnectedServiceCredentialRevisionV1Schema,
  type QualifiedConnectedAccountGroupV4,
} from '@happier-dev/protocol';

import type { ApiClient } from '@/api/api';
import {
  HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY,
  type ConnectedServiceChildSelection,
} from '../connectedServiceChildEnvironment';
import { DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1 } from '../accountGroups/selection/selectConnectedServiceAuthGroupCandidate';
import { ConnectedServiceRuntimeRegistry } from '../runtimeRegistry/registry';
import {
  ConnectedServiceRefreshCoordinator,
  type QualifiedConnectedAccountRefreshRuntime,
} from './ConnectedServiceRefreshCoordinator';
import { createBuiltInQualifiedRefreshHarness } from './ConnectedServiceRefreshCoordinator.qualifiedRefresh.testkit';

const sourceRevision = ConnectedServiceCredentialRevisionV1Schema.parse(
  'csr_aaaaaaaaaaaaaaaaaaaaaa',
);

afterEach(() => vi.unstubAllGlobals());

function selectionEnv(
  selections: ReadonlyArray<ConnectedServiceChildSelection>,
): Readonly<Record<string, string>> {
  return {
    [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]:
      JSON.stringify(selections),
  };
}

const qualifiedOpenAiService = {
  pluginId: 'happier.agent.codex',
  localId: 'openai-codex',
} as const;

function qualifiedGroupForCanonicalRefresh(input: Readonly<{
  activeAccountId: string;
  generation: number;
}>): QualifiedConnectedAccountGroupV4 {
  return {
    v: 1,
    ref: { service: qualifiedOpenAiService, groupId: 'pool' },
    incarnation: 'qualified-group-row-pool',
    displayName: 'Pool',
    policy: {
      ...DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1,
      autoSwitch: false,
    },
    activeConnectedAccountId: input.activeAccountId,
    generation: input.generation,
    runtimeStateRevision: 0,
    state: {},
    createdAt: 1,
    updatedAt: 1,
    members: [{
      v: 1,
      connectedAccountId: input.activeAccountId,
      priority: 1,
      enabled: true,
      state: {},
      createdAt: 1,
      updatedAt: 1,
    }],
  };
}

describe('ConnectedServiceRefreshCoordinator canonical group distribution', () => {
  it('reads current group truth for every provider-materialization decision', async () => {
    const now = 3_000_000;
    let activeProfileId = 'work';
    let generation = 7;
    const runtimeRegistry = new ConnectedServiceRuntimeRegistry();
    runtimeRegistry.registerTarget({
      pid: 504,
      agentId: 'codex',
      sessionId: 'canonical-group-current-session',
      materializationKey: 'canonical-group-current-session',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': {
            source: 'connected',
            selection: 'group',
            groupId: 'pool',
            profileId: 'work',
          },
        },
      },
      connectedServiceSelectionsEnv: selectionEnv([{
        kind: 'group',
        serviceId: 'openai-codex',
        groupId: 'pool',
        activeProfileId: 'work',
        fallbackProfileId: 'backup',
        generation: 7,
        policy: null,
        credentialRevision: sourceRevision,
      }]),
    });
    const readGroup = vi.fn(async () => qualifiedGroupForCanonicalRefresh({
      activeAccountId: activeProfileId,
      generation,
    }));
    const api = {} as ApiClient;
    const coordinator = new ConnectedServiceRefreshCoordinator({
      api,
      credentials: {
        token: 'happy-token',
        encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
      },
      machineIdProvider: () => 'current-daemon',
      activeServerDir: '/tmp/happier-dev-canonical-group-current-server',
      baseDir: '/tmp/happier-dev-canonical-group-current',
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
      runtimeRegistry,
      qualifiedConnectedAccountRuntime: {
        resolvePeerClass: () => 'advertised_v4',
        readGroup,
      } as unknown as QualifiedConnectedAccountRefreshRuntime,
    });
    const target = runtimeRegistry.listRefreshTargets()[0];
    if (!target) throw new Error('fixture target must be refreshable');
    const internals = coordinator as unknown as {
      canonicalizeTargetSelectionsForRefresh(
        inputTarget: typeof target,
      ): Promise<typeof target | null>;
    };

    await internals.canonicalizeTargetSelectionsForRefresh(target);
    activeProfileId = 'backup';
    generation = 8;
    const current = await internals.canonicalizeTargetSelectionsForRefresh(target);

    expect(current?.bindings).toContainEqual({
      serviceId: 'happier.agent.codex/openai-codex',
      profileId: 'backup',
    });
    expect(current?.childSelectionsByServiceId?.get('happier.agent.codex/openai-codex')).toMatchObject({
      activeProfileId: 'backup',
      generation: 8,
    });
    expect(readGroup).toHaveBeenLastCalledWith({
      service: qualifiedOpenAiService,
      groupId: 'pool',
    });
  });

  it('reports refresh failure when a registered group target cannot read canonical group state', async () => {
    const credentialRevision = ConnectedServiceCredentialRevisionV1Schema.parse('csr_abcdefghijklmnopqrstuv');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
        access_token: 'refreshed-access',
        refresh_token: 'refreshed-refresh',
        expires_in: 3600,
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch);
    const runtimeRegistry = new ConnectedServiceRuntimeRegistry();
    runtimeRegistry.registerTarget({
      pid: 505,
      agentId: 'codex',
      sessionId: 'canonical-group-unavailable-session',
      materializationKey: 'canonical-group-unavailable-session',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': {
            source: 'connected',
            selection: 'group',
            groupId: 'pool',
            profileId: 'work',
          },
        },
      },
      connectedServiceSelectionsEnv: selectionEnv([{
        kind: 'group',
        serviceId: 'openai-codex',
        groupId: 'pool',
        activeProfileId: 'work',
        fallbackProfileId: 'backup',
        generation: 7,
        policy: null,
        credentialRevision,
      }]),
    });
    const harness = await createBuiltInQualifiedRefreshHarness({
      runtimeRegistry,
      readGroup: async () => { throw new Error('canonical group unavailable'); },
    });

    try {
      await expect(
        harness.coordinator.refreshConnectedServiceCredentialForSpawnPreflight({
          serviceId: 'openai-codex',
          profileId: 'work',
          force: true,
        }),
      ).resolves.toMatchObject({
        status: 'refresh_failed',
        diagnostic: {
          providerErrorCode: 'canonical_group_state_unavailable',
        },
      });
      expect(
        runtimeRegistry
          .getByPid(505)
          ?.activeBindings.find(
            (binding) => binding.serviceId === 'happier.agent.codex/openai-codex',
          )
          ?.credentialRevision,
      ).toBe(credentialRevision);
    } finally {
      await harness.dispose();
    }
  });
});
