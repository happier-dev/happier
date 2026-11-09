import { describe, expect, it } from 'vitest';
import { ConnectedServiceRuntimeRegistry } from '../runtimeRegistry/registry';
import { HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY } from '../connectedServiceChildEnvironment';
import { handleProviderObservedSessionAccount, reconcileProviderObservedSessionAccount } from './reconcileProviderObservedSessionAccount';
import { ConnectedServiceAuthGroupGenerationConsumer } from '../accountGroups/generation/ConnectedServiceAuthGroupGenerationConsumer';
import { reconcileConnectedServiceAuthGroupGenerationForRuntimeTarget } from '../accountGroups/generation/reconcileConnectedServiceAuthGroupGenerations';

function setup(generation = 7) {
  const runtimeRegistry = new ConnectedServiceRuntimeRegistry();
  runtimeRegistry.registerTarget({
    pid: 42, sessionId: 'session', agentId: 'claude',
    connectedServicesBindingsRaw: { v: 2, bindingsByServiceId: {
      'happier.agent.claude/claude-subscription': { source: 'connected', selection: 'group', groupId: 'pool', profileId: 'a' },
    } },
    connectedServiceSelectionsEnv: { [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
      kind: 'group', serviceId: 'happier.agent.claude/claude-subscription', groupId: 'pool',
      activeProfileId: 'a', fallbackProfileId: 'a', generation,
      credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
    }]) },
  });
  return {
    target: runtimeRegistry.getBySessionId('session')!,
    input: {
      runtimeRegistry, sessionId: 'session', serviceId: 'happier.agent.claude/claude-subscription' as const, groupId: 'pool',
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
      profileId: 'b', groupGeneration: null, credentialRevision: null,
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

  it('leaves a newer exact adoption and retired requester authority unchanged during lookup', async () => {
    const { input } = setup();
    let current = true;
    expect(await reconcileProviderObservedSessionAccount({ ...input, isCurrent: async () => current,
      getGroup: async () => { current = false; return await input.getGroup(); },
    })).toBeNull();
    expect(input.runtimeRegistry.getBySessionId('session')?.activeBindings[0]?.profileId).toBe('a');
    expect(await reconcileProviderObservedSessionAccount({ ...input, observedAtMs: Date.now() + 1_000, getGroup: async () => {
      input.runtimeRegistry.adoptExactGroupApplicationForSession({ sessionId: 'session', serviceId: input.serviceId,
        groupId: 'pool', profileId: 'c', generation: 8, credentialRevision: 'csr_cccccccccccccccccccccc' });
      return await input.getGroup();
    } })).toBeNull();
    expect(input.runtimeRegistry.getBySessionId('session')?.activeBindings[0]).toMatchObject({ profileId: 'c', groupGeneration: 8 });
  });

  it('catches up through the generation owner even when the public metadata transport fails', async () => {
    const { input } = setup();
    const credentialRevision = 'csr_aaaaaaaaaaaaaaaaaaaaaa';
    const consumer = new ConnectedServiceAuthGroupGenerationConsumer({
      resolveGenerationApplicationScope: async () => ({ status: 'supported', scope: 'per_session_runtime', ownerId: 'runner' }),
      verifySharedGenerationApplication: async () => null,
      // Provider application/verification is the external runner boundary. Keep the
      // generation decision, recipient reconciliation and registry settlement real.
      applyCommittedGeneration: async ({ committedGeneration }) => ({
        reconciliationDisposition: 'converged', errorCode: null,
        providerAdoptedTarget: {
          ...committedGeneration.decisionCommittedTarget, credentialRevision,
          proof: { status: 'verified', source: 'codex_app_server', credentialRevision },
        },
      }),
      clearAdoptedGeneration: async ({ sessionId, providerAdoptedTarget }) => {
        input.runtimeRegistry.adoptExactGroupApplicationForSession({ sessionId, ...providerAdoptedTarget, credentialRevision });
      },
    });
    await expect(handleProviderObservedSessionAccount({
      ...input,
      // Public metadata is a separate network boundary from provider application.
      publishAccount: async () => { throw new Error('metadata transport unavailable'); },
      reconcileGeneration: async (target) => {
        await reconcileConnectedServiceAuthGroupGenerationForRuntimeTarget({
          target: { ...target, isCurrent: () => input.runtimeRegistry.resolveExactSessionGroupApplicationTarget(target) !== null,
            activeBindings: target.activeBindings.map(binding => ({ ...binding, generation: binding.groupGeneration })) }, consumer, executionAuthority: 'passive_projection',
          listCurrentGroups: async () => [{ serviceId: 'happier.agent.claude/claude-subscription', groupId: 'pool', activeProfileId: 'c', generation: 8 }],
          resolveCredentialRevision: () => credentialRevision,
          resolveCredentialPresence: () => ({ status: 'present', credentialRevision }),
        });
      },
    })).rejects.toThrow('metadata transport unavailable');
    expect(input.runtimeRegistry.getBySessionId('session')?.activeBindings[0]).toMatchObject({
      profileId: 'c', groupGeneration: 8, credentialRevision,
    });
  });
});
