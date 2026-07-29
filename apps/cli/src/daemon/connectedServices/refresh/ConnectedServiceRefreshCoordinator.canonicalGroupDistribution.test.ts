import { describe, expect, it, vi } from 'vitest';

import {
  buildConnectedServiceCredentialRecord,
  ConnectedServiceCredentialRevisionV1Schema,
  type ConnectedServiceCredentialRecordV1,
} from '@happier-dev/protocol';

import type { ApiClient } from '@/api/api';
import type { Credentials } from '@/persistence';
import {
  HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY,
  type ConnectedServiceChildSelection,
} from '../connectedServiceChildEnvironment';
import { ConnectedServiceRuntimeRegistry } from '../runtimeRegistry/registry';
import {
  ConnectedServiceRefreshCoordinator,
  type QualifiedConnectedAccountRefreshRuntime,
} from './ConnectedServiceRefreshCoordinator';

const sourceRevision = ConnectedServiceCredentialRevisionV1Schema.parse(
  'csr_aaaaaaaaaaaaaaaaaaaaaa',
);
const refreshedRevision = ConnectedServiceCredentialRevisionV1Schema.parse(
  'csr_bbbbbbbbbbbbbbbbbbbbbb',
);

function selectionEnv(
  selections: ReadonlyArray<ConnectedServiceChildSelection>,
): Readonly<Record<string, string>> {
  return {
    [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]:
      JSON.stringify(selections),
  };
}

describe('ConnectedServiceRefreshCoordinator canonical group distribution', () => {
  it('can bypass cached group truth for a provider-materialization decision', async () => {
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
    const api = {
      getConnectedServiceAuthGroup: vi.fn(async () => ({
        serviceId: 'openai-codex',
        groupId: 'pool',
        activeProfileId,
        generation,
      })),
    } as unknown as ApiClient;
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
    });
    const target = runtimeRegistry.listRefreshTargets()[0];
    if (!target) throw new Error('fixture target must be refreshable');
    const internals = coordinator as unknown as {
      canonicalizeTargetSelectionsForRefresh(
        inputTarget: typeof target,
        options?: Readonly<{ requireFreshGroupState?: boolean }>,
      ): Promise<typeof target | null>;
    };

    await internals.canonicalizeTargetSelectionsForRefresh(target);
    activeProfileId = 'backup';
    generation = 8;
    const current = await internals.canonicalizeTargetSelectionsForRefresh(target, {
      requireFreshGroupState: true,
    });

    expect(current?.bindings).toContainEqual({
      serviceId: 'openai-codex',
      profileId: 'backup',
    });
    expect(current?.childSelectionsByServiceId?.get('openai-codex')).toMatchObject({
      activeProfileId: 'backup',
      generation: 8,
    });
  });

  it('reports refresh failure when a registered group target cannot read canonical group state', async () => {
    const now = 3_000_000;
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    let credentialRevision = sourceRevision;
    let record: ConnectedServiceCredentialRecordV1 =
      buildConnectedServiceCredentialRecord({
        now,
        serviceId: 'openai-codex',
        profileId: 'work',
        kind: 'oauth',
        expiresAt: now - 1,
        oauth: {
          accessToken: 'source-access',
          refreshToken: 'source-refresh',
          idToken: null,
          scope: null,
          tokenType: null,
          providerAccountId: 'account-work',
          providerEmail: null,
        },
      });
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceCredentialPlain: vi.fn(async () => ({
        revisionSemantics: 'revisioned' as const,
        credentialRevision,
        content: { t: 'plain' as const, v: record },
      })),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      getConnectedServiceAuthGroup: vi.fn(async () => null),
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({
        acquired: true,
        leaseUntil: now + 60_000,
        ownerId: 'current-daemon',
        credentialRevision: sourceRevision,
      })),
      registerConnectedServiceCredentialPlain: vi.fn(async (input: {
        content: { v: ConnectedServiceCredentialRecordV1 };
      }) => {
        record = input.content.v;
        credentialRevision = refreshedRevision;
        return {
          success: true as const,
          credentialRevision: refreshedRevision,
        };
      }),
      updateConnectedServiceCredentialHealth: vi.fn(async () => ({
        success: true as const,
      })),
    } as unknown as ApiClient;
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        access_token: 'refreshed-access',
        refresh_token: 'refreshed-refresh',
        expires_in: 3600,
      }),
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
        credentialRevision: sourceRevision,
      }]),
    });
    const coordinator = new ConnectedServiceRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'current-daemon',
      activeServerDir:
        '/tmp/happier-dev-canonical-group-distribution-server',
      baseDir: '/tmp/happier-dev-canonical-group-distribution',
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
      runtimeRegistry,
      // This fixture exercises the released revisioned V2/V3 OAuth-refresh
      // compatibility path. The plugin-owned V4 authority is deliberately
      // unreachable for that peer class.
      qualifiedConnectedAccountRuntime: {
        resolvePeerClass: () => 'revisioned_v2_v3',
        establishedRuntimeOwner: {
          invokeWithReceipt: vi.fn(async () => {
            throw new Error('revisioned V2/V3 fixture cannot invoke a V4 plugin leaf');
          }),
        },
        mutateCredentialHealth: vi.fn(async () => {
          throw new Error('revisioned V2/V3 fixture cannot mutate V4 credential health');
        }),
        readCredential: vi.fn(async () => {
          throw new Error('revisioned V2/V3 fixture cannot read a V4 credential');
        }),
        acquireRefreshLease: vi.fn(async () => {
          throw new Error('revisioned V2/V3 fixture cannot acquire a V4 refresh lease');
        }),
        mutateCredential: vi.fn(async () => {
          throw new Error('revisioned V2/V3 fixture cannot mutate a V4 credential');
        }),
      } as unknown as QualifiedConnectedAccountRefreshRuntime,
    });

    await expect(
      coordinator.refreshConnectedServiceCredentialForSpawnPreflight({
        serviceId: 'openai-codex',
        profileId: 'work',
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
          (binding) => binding.serviceId === 'openai-codex',
        )
        ?.credentialRevision,
    ).toBe(sourceRevision);
  });
});
