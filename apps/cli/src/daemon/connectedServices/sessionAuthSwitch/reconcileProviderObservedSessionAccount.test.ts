import { describe, expect, it } from 'vitest';
import { ConnectedServiceRuntimeRegistry } from '../runtimeRegistry/registry';
import { HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY } from '../connectedServiceChildEnvironment';
import { handleProviderObservedSessionAccount, reconcileProviderObservedSessionAccount } from './reconcileProviderObservedSessionAccount';
import { ConnectedServiceAuthGroupGenerationConsumer } from '../accountGroups/generation/ConnectedServiceAuthGroupGenerationConsumer';
import { reconcileConnectedServiceAuthGroupGenerationForRuntimeTarget } from '../accountGroups/generation/reconcileConnectedServiceAuthGroupGenerations';
import { DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1 } from '../accountGroups/selection/selectConnectedServiceAuthGroupCandidate';

function setup(generation = 7) {
  const runtimeRegistry = new ConnectedServiceRuntimeRegistry({ nowMs: () => 100 });
  const target = runtimeRegistry.registerTarget({
    pid: 42, sessionId: 'session', agentId: 'claude',
    connectedServicesBindingsRaw: { v: 1, bindingsByServiceId: {
      'claude-subscription': { source: 'connected', selection: 'group', groupId: 'pool', profileId: 'a' },
    } },
    connectedServiceSelectionsEnv: { [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
      kind: 'group', serviceId: 'claude-subscription', groupId: 'pool',
      activeProfileId: 'a', fallbackProfileId: 'a', generation,
      credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
    }]) },
  });
  return {
    target,
    input: {
      runtimeRegistry, sessionId: 'session', serviceId: 'claude-subscription' as const, groupId: 'pool',
      providerOrganizationId: 'org-b', observedAtMs: 200,
      sourceSessionId: 'provider-session', getCurrentProviderSessionId: () => 'provider-session' as string | null,
      getGroup: async () => ({ generation: 8, activeProfileId: 'c', members: [{ profileId: 'a' }, { profileId: 'b' }, { profileId: 'c' }] }),
      resolveProviderAccountIdentity: async (profileId: string) => ({ providerAccountId: profileId, providerOrganizationId: `org-${profileId}` }),
    },
  };
}

describe('reconcileProviderObservedSessionAccount', () => {
  it('records a uniquely observed non-current member, leaving generation/revision unproven and identifying generation catch-up', async () => {
    const { input } = setup();
    const result = await reconcileProviderObservedSessionAccount({ ...input, observedAtMs: 50 });
    expect(result?.generationBehind).toBe(true);
    expect(input.runtimeRegistry.getBySessionId('session')?.activeBindings[0]).toMatchObject({
      profileId: 'b', generation: null, credentialRevision: null,
    });
  });

  it('does not request another apply at the current generation or rewrite from an older observation', async () => {
    const { input } = setup(8);
    expect((await reconcileProviderObservedSessionAccount(input))?.generationBehind).toBe(false);
    expect(await reconcileProviderObservedSessionAccount({ ...input, providerOrganizationId: 'org-a', observedAtMs: 150 })).toBeNull();
    expect(input.runtimeRegistry.getBySessionId('session')?.activeBindings[0]?.profileId).toBe('b');
  });

  it('leaves recorded identity unchanged when an organization is shared or missing', async () => {
    const { input, target } = setup();
    expect(await reconcileProviderObservedSessionAccount({ ...input,
      resolveProviderAccountIdentity: async () => ({ providerAccountId: 'shared', providerOrganizationId: 'org-b' }),
    })).toBeNull();
    expect(await reconcileProviderObservedSessionAccount({ ...input, providerOrganizationId: null })).toBeNull();
    expect(input.runtimeRegistry.getBySessionId('session')).toBe(target);
  });

  it('ignores an old provider session and a provider session replaced during identity resolution', async () => {
    const { input, target } = setup();
    expect(await reconcileProviderObservedSessionAccount({ ...input, sourceSessionId: 'previous-provider-session' })).toBeNull();
    let providerSessionId = 'provider-session';
    expect(await reconcileProviderObservedSessionAccount({ ...input,
      getCurrentProviderSessionId: () => providerSessionId,
      getGroup: async () => {
        providerSessionId = 'replacement-provider-session';
        return await input.getGroup();
      },
    })).toBeNull();
    expect(input.runtimeRegistry.getBySessionId('session')).toBe(target);
  });

  it('catches up through the generation owner even when the public metadata transport fails', async () => {
    const { input } = setup();
    const credentialRevision = 'csr_aaaaaaaaaaaaaaaaaaaaaa';
    const consumer = new ConnectedServiceAuthGroupGenerationConsumer({
      resolveGenerationApplicationScope: async () => ({ status: 'supported', scope: 'per_session_runtime', ownerId: 'runner' }),
      verifySharedGenerationApplication: async () => null,
      notifyCurrentGroupTruth: async () => ({ ok: true }),
      // Provider application/verification is the external runner boundary. Keep the
      // generation decision, recipient reconciliation and registry settlement real.
      applyCommittedGeneration: async ({ committedGeneration }) => ({
        reconciliationDisposition: 'converged', errorCode: null,
        providerAdoptedTarget: {
          ...committedGeneration.decisionCommittedTarget, credentialRevision,
          proof: { status: 'verified', source: 'codex_app_server', credentialRevision },
        },
      }),
      settleExactRecipientApplication: async ({ sessionId, providerAdoptedTarget }) => {
        input.runtimeRegistry.adoptExactGroupApplicationForSession({ sessionId, ...providerAdoptedTarget });
      },
    });
    await expect(handleProviderObservedSessionAccount({
      ...input,
      // Public metadata is a separate network boundary from provider application.
      publishAccount: async () => { throw new Error('metadata transport unavailable'); },
      reconcileGeneration: async (target) => {
        await reconcileConnectedServiceAuthGroupGenerationForRuntimeTarget({
          target, consumer, executionAuthority: 'passive_projection',
          listCurrentGroups: async () => [{
            v: 1, serviceId: 'claude-subscription', groupId: 'pool', displayName: 'Pool',
            activeProfileId: 'c', generation: 8, runtimeStateRevision: 0,
            policy: DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1,
            state: { status: 'ready' }, createdAt: 1, updatedAt: 1, members: [],
          }],
          resolveCredentialRevision: () => credentialRevision,
          resolveCredentialBoundary: () => ({ status: 'present', revisionSemantics: 'revisioned', credentialRevision }),
        });
      },
    })).rejects.toThrow('metadata transport unavailable');
    expect(input.runtimeRegistry.getBySessionId('session')?.activeBindings[0]).toMatchObject({
      profileId: 'c', generation: 8, credentialRevision,
    });
  });
});
