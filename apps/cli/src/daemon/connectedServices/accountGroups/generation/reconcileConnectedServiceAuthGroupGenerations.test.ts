import { describe, expect, it, vi } from 'vitest';

import { ConnectedServiceAuthGroupGenerationConsumer } from './ConnectedServiceAuthGroupGenerationConsumer';
import { ConnectedServiceRuntimeRegistry } from '../../runtimeRegistry/registry';
import {
  reconcileConnectedServiceAuthGroupGenerationForRuntimeTarget,
  reconcileConnectedServiceDirectCredentialRevisions,
} from './reconcileConnectedServiceAuthGroupGenerations';

const executionAuthority = 'passive_projection' as const;
const revisionedCredentialPresence = () => ({
  status: 'present' as const,
  credentialRevision: 'csr_bbbbbbbbbbbbbbbbbbbbbb',
});

function createConsumer() {
  const applyCommittedGeneration = vi.fn(async (input) => ({
    reconciliationDisposition: 'converged' as const,
    errorCode: null,
    providerAdoptedTarget: {
      ...input.committedGeneration.decisionCommittedTarget,
      proof: {
        status: 'verified' as const,
        source: 'test',
        credentialRevision: input.committedGeneration.decisionCommittedTarget.credentialRevision,
      },
    },
  }));
  const enforceGroupUnavailable = vi.fn(async () => {});
  const clearAdoptedGeneration = vi.fn(async () => ({ status: 'cleared' as const }));
  const consumer = new ConnectedServiceAuthGroupGenerationConsumer({
    applyCommittedGeneration,
    enforceGroupUnavailable,
    clearAdoptedGeneration,
    resolveGenerationApplicationScope: vi.fn(async ({ sessionId }) => ({
      status: 'supported' as const,
      scope: 'per_session_runtime' as const,
      ownerId: sessionId,
    })),
    verifySharedGenerationApplication: vi.fn(async () => null),
  });
  return { consumer, applyCommittedGeneration, enforceGroupUnavailable, clearAdoptedGeneration };
}

describe('live connected-service projection reconciliation', () => {
  it.each(['metadata-only', 'selection-update', 'replacement', 'unbind'] as const)(
    'delivers availability only to the original live pool recipient through %s settlement', async (scenario) => {
      const registry = new ConnectedServiceRuntimeRegistry();
      const serviceId = 'happier.agent.codex/openai-codex';
      const bindings = { v: 2, bindingsByServiceId: { [serviceId]: {
        source: 'connected', selection: 'group', groupId: 'team', profileId: 'previous',
      } } };
      registry.registerTarget({ pid: 123, agentId: 'codex', sessionId: 'recipient', connectedServicesBindingsRaw: bindings,
        ...(scenario === 'metadata-only' ? {} : { connectedServiceSelectionsEnvRaw: JSON.stringify([{
          kind: 'group', serviceId, groupId: 'team', activeProfileId: 'previous', fallbackProfileId: 'previous',
          generation: 2, policy: null, credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
        }]) }),
      });
      const original = registry.getBySessionId('recipient')!;
      const available: string[] = [];
      const consumer = new ConnectedServiceAuthGroupGenerationConsumer({
        resolveGenerationApplicationScope: async () => ({ status: 'supported', scope: 'per_session_runtime', ownerId: 'codex' }),
        verifySharedGenerationApplication: async () => null,
        applyCommittedGeneration: async ({ committedGeneration }) => {
          if (scenario === 'replacement') {
            registry.unregisterPid(123);
            registry.registerTarget(original);
          } else if (scenario === 'unbind') {
            registry.updateTarget({ pid: 123, connectedServicesBindingsRaw: { v: 2, bindingsByServiceId: {} },
              connectedServiceSelectionsEnvRaw: '[]' });
          }
          return { reconciliationDisposition: 'converged', errorCode: null,
            providerAdoptedTarget: { ...committedGeneration.decisionCommittedTarget,
              proof: { status: 'verified', source: 'provider_read', credentialRevision: 'csr_bbbbbbbbbbbbbbbbbbbbbb' } } };
        },
        clearAdoptedGeneration: async ({ providerAdoptedTarget }) => {
          if (!providerAdoptedTarget.credentialRevision) throw new Error('credential_revision_missing');
          const settled = registry.adoptExactGroupApplicationForSession({ ...providerAdoptedTarget,
            sessionId: 'recipient', credentialRevision: providerAdoptedTarget.credentialRevision });
          if (!settled) throw new Error('provider_adoption_runtime_binding_unavailable');
          available.push(providerAdoptedTarget.credentialRevision);
        },
      });
      await reconcileConnectedServiceAuthGroupGenerationForRuntimeTarget({
        target: { ...original, isCurrent: () => registry.resolveExactSessionGroupApplicationTarget(original) !== null,
          activeBindings: original.activeBindings.map(binding => ({ ...binding, generation: binding.groupGeneration })) },
        consumer, listCurrentGroups: async () => [{ serviceId, groupId: 'team', activeProfileId: 'current', generation: 3 }],
        resolveCredentialRevision: () => 'csr_bbbbbbbbbbbbbbbbbbbbbb', resolveCredentialPresence: revisionedCredentialPresence,
        executionAuthority,
      });
      const retained = scenario === 'metadata-only' || scenario === 'selection-update';
      expect(available).toEqual(retained ? ['csr_bbbbbbbbbbbbbbbbbbbbbb'] : []);
      expect(registry.resolveExactSessionGroupApplicationTarget(original) !== null).toBe(retained);
    });
  it('applies exact current group truth only to the supplied live runtime target', async () => {
    const { consumer, applyCommittedGeneration } = createConsumer();
    await expect(reconcileConnectedServiceAuthGroupGenerationForRuntimeTarget({
      target: {
        sessionId: 'live-session',
        agentId: 'live-agent',
        connectedServicesBindingsRaw: {
          v: 2,
          bindingsByServiceId: {
            'happier.agent.codex/openai-codex': {
              source: 'connected', selection: 'group', groupId: 'team', profileId: 'old',
            },
          },
        },
        activeBindings: [],
      },
      consumer,
      listCurrentGroups: vi.fn(async () => [{
        serviceId: 'happier.agent.codex/openai-codex' as const,
        groupId: 'team',
        activeProfileId: 'new',
        generation: 3,
      }]),
      resolveCredentialRevision: () => 'csr_bbbbbbbbbbbbbbbbbbbbbb',
      resolveCredentialPresence: revisionedCredentialPresence,
      executionAuthority,
    })).resolves.toEqual({ acknowledgeable: true, reconciledGroupCount: 1, sessionDispositionCount: 1 });

    expect(applyCommittedGeneration).toHaveBeenCalledOnce();
    expect(applyCommittedGeneration).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'live-session',
      committedGeneration: expect.objectContaining({
        decisionCommittedTarget: expect.objectContaining({
          profileId: 'new',
          generation: 3,
          credentialRevision: 'csr_bbbbbbbbbbbbbbbbbbbbbb',
        }),
      }),
    }));
  });

  it('does not re-apply an exact target produced by successful spawn materialization', async () => {
    const { consumer, applyCommittedGeneration, clearAdoptedGeneration } = createConsumer();
    await expect(reconcileConnectedServiceAuthGroupGenerationForRuntimeTarget({
      target: {
        sessionId: 'fresh-session',
        agentId: 'codex',
        connectedServiceMaterializationIdentityV1: {
          id: 'csm_fresh_session',
        },
        connectedServicesBindingsRaw: {
          v: 2,
          bindingsByServiceId: {
            'happier.agent.codex/openai-codex': {
              source: 'connected', selection: 'group', groupId: 'team', profileId: 'current',
            },
          },
        },
        activeBindings: [{
          serviceId: 'happier.agent.codex/openai-codex',
          groupId: 'team',
          profileId: 'current',
          generation: 3,
          credentialRevision: 'csr_bbbbbbbbbbbbbbbbbbbbbb',
        }],
      },
      consumer,
      listCurrentGroups: vi.fn(async () => [{
        serviceId: 'happier.agent.codex/openai-codex' as const,
        groupId: 'team',
        activeProfileId: 'current',
        generation: 3,
      }]),
      resolveCredentialRevision: () => 'csr_bbbbbbbbbbbbbbbbbbbbbb',
      resolveCredentialPresence: revisionedCredentialPresence,
      executionAuthority,
    })).resolves.toEqual({ acknowledgeable: true, reconciledGroupCount: 0, sessionDispositionCount: 0 });

    expect(applyCommittedGeneration).not.toHaveBeenCalled();
    expect(clearAdoptedGeneration).toHaveBeenCalledWith(expect.objectContaining({
      providerAdoptedTarget: expect.objectContaining({ credentialRevision: 'csr_bbbbbbbbbbbbbbbbbbbbbb' }),
    }));
  });

  it('settles a durable exact provider-adoption proof without re-applying the provider effect', async () => {
    const { consumer, applyCommittedGeneration, clearAdoptedGeneration } = createConsumer();
    const providerAdoptedTarget = {
      serviceId: 'happier.agent.codex/openai-codex' as const,
      groupId: 'team',
      profileId: 'current',
      generation: 3,
      credentialRevision: 'csr_bbbbbbbbbbbbbbbbbbbbbb' as const,
      proof: {
        status: 'verified' as const,
        source: 'test',
        credentialRevision: 'csr_bbbbbbbbbbbbbbbbbbbbbb' as const,
      },
    };

    await expect(reconcileConnectedServiceAuthGroupGenerationForRuntimeTarget({
      target: {
        sessionId: 'durably-adopted-session',
        agentId: 'codex',
        connectedServicesBindingsRaw: {
          v: 2,
          bindingsByServiceId: {
            'happier.agent.codex/openai-codex': {
              source: 'connected', selection: 'group', groupId: 'team', profileId: 'previous',
            },
          },
        },
        activeBindings: [{
          serviceId: 'happier.agent.codex/openai-codex',
          groupId: 'team',
          profileId: 'previous',
          generation: 2,
          credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
        }],
      },
      providerAdoptedTargets: [providerAdoptedTarget],
      consumer,
      listCurrentGroups: vi.fn(async () => [{
        serviceId: 'happier.agent.codex/openai-codex' as const,
        groupId: 'team',
        activeProfileId: 'current',
        generation: 3,
      }]),
      resolveCredentialRevision: () => 'csr_bbbbbbbbbbbbbbbbbbbbbb',
      resolveCredentialPresence: revisionedCredentialPresence,
      executionAuthority,
    })).resolves.toEqual({ acknowledgeable: true, reconciledGroupCount: 0, sessionDispositionCount: 0 });

    expect(applyCommittedGeneration).not.toHaveBeenCalled();
    expect(clearAdoptedGeneration).toHaveBeenCalledWith({
      sessionId: 'durably-adopted-session',
      providerAdoptedTarget,
    });
  });

  it('re-applies a revisionless pool projection before acknowledging availability', async () => {
    const { consumer, applyCommittedGeneration } = createConsumer();
    await expect(reconcileConnectedServiceAuthGroupGenerationForRuntimeTarget({
      target: {
        sessionId: 'legacy-session',
        agentId: 'claude',
        connectedServiceMaterializationIdentityV1: {
          id: 'csm_legacy_session',
        },
        connectedServicesBindingsRaw: {
          v: 2,
          bindingsByServiceId: {
            'happier.agent.claude/anthropic': {
              source: 'connected', selection: 'group', groupId: 'team', profileId: 'current',
            },
          },
        },
        activeBindings: [{
          serviceId: 'happier.agent.claude/anthropic',
          groupId: 'team',
          profileId: 'current',
          generation: 3,
          credentialRevision: null,
        }],
      },
      consumer,
      listCurrentGroups: vi.fn(async () => [{
        serviceId: 'happier.agent.claude/anthropic' as const,
        groupId: 'team',
        activeProfileId: 'current',
        generation: 3,
      }]),
      resolveCredentialRevision: () => null,
      resolveCredentialPresence: () => ({ status: 'legacy_unfenced' }),
      executionAuthority,
    })).rejects.toThrow('connected_service_generation_reconciliation_not_acknowledgeable');

    expect(applyCommittedGeneration).toHaveBeenCalledOnce();
  });

  it('does not treat an absent credential as a successfully materialized legacy credential', async () => {
    const { consumer, applyCommittedGeneration } = createConsumer();
    await expect(reconcileConnectedServiceAuthGroupGenerationForRuntimeTarget({
      target: {
        sessionId: 'missing-credential-session',
        agentId: 'claude',
        connectedServiceMaterializationIdentityV1: {
          id: 'csm_missing_credential_session',
        },
        connectedServicesBindingsRaw: {
          v: 2,
          bindingsByServiceId: {
            'happier.agent.claude/anthropic': {
              source: 'connected', selection: 'group', groupId: 'team', profileId: 'current',
            },
          },
        },
        activeBindings: [{
          serviceId: 'happier.agent.claude/anthropic',
          groupId: 'team',
          profileId: 'current',
          generation: 3,
          credentialRevision: null,
        }],
      },
      consumer,
      listCurrentGroups: vi.fn(async () => [{
        serviceId: 'happier.agent.claude/anthropic' as const,
        groupId: 'team',
        activeProfileId: 'current',
        generation: 3,
      }]),
      resolveCredentialRevision: () => null,
      resolveCredentialPresence: () => ({ status: 'absent' }),
      executionAuthority,
    })).rejects.toThrow('connected_service_generation_reconciliation_not_acknowledgeable');
    expect(applyCommittedGeneration).toHaveBeenCalledOnce();
  });

  it('reconciles a materialized target whose real credential revision mismatches current truth', async () => {
    const { consumer, applyCommittedGeneration } = createConsumer();
    await expect(reconcileConnectedServiceAuthGroupGenerationForRuntimeTarget({
      target: {
        sessionId: 'stale-revision-session',
        agentId: 'claude',
        connectedServiceMaterializationIdentityV1: {
          id: 'csm_stale_revision_session',
        },
        connectedServicesBindingsRaw: {
          v: 2,
          bindingsByServiceId: {
            'happier.agent.claude/anthropic': {
              source: 'connected', selection: 'group', groupId: 'team', profileId: 'current',
            },
          },
        },
        activeBindings: [{
          serviceId: 'happier.agent.claude/anthropic',
          groupId: 'team',
          profileId: 'current',
          generation: 3,
          credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
        }],
      },
      consumer,
      listCurrentGroups: vi.fn(async () => [{
        serviceId: 'happier.agent.claude/anthropic' as const,
        groupId: 'team',
        activeProfileId: 'current',
        generation: 3,
      }]),
      resolveCredentialRevision: () => 'csr_bbbbbbbbbbbbbbbbbbbbbb',
      resolveCredentialPresence: () => ({
        status: 'present',
        credentialRevision: 'csr_bbbbbbbbbbbbbbbbbbbbbb',
      }),
      executionAuthority,
    })).resolves.toEqual({ acknowledgeable: true, reconciledGroupCount: 1, sessionDispositionCount: 1 });

    expect(applyCommittedGeneration).toHaveBeenCalledWith(expect.objectContaining({
      committedGeneration: expect.objectContaining({
        decisionCommittedTarget: expect.objectContaining({
          credentialRevision: 'csr_bbbbbbbbbbbbbbbbbbbbbb',
        }),
      }),
    }));
  });

  it('enforces unavailable truth on the supplied live runtime target without persisting offline work', async () => {
    const { consumer, enforceGroupUnavailable } = createConsumer();
    await expect(reconcileConnectedServiceAuthGroupGenerationForRuntimeTarget({
      target: {
        sessionId: 'live-session',
        connectedServicesBindingsRaw: {
          v: 2,
          bindingsByServiceId: {
            'happier.agent.codex/openai-codex': {
              source: 'connected', selection: 'group', groupId: 'team', profileId: 'old',
            },
          },
        },
        activeBindings: [],
      },
      consumer,
      listCurrentGroups: vi.fn(async () => []),
      resolveCredentialRevision: () => null,
      resolveCredentialPresence: () => ({ status: 'absent' }),
      executionAuthority,
    })).resolves.toEqual({ acknowledgeable: true, reconciledGroupCount: 0, sessionDispositionCount: 1 });

    expect(enforceGroupUnavailable).toHaveBeenCalledWith({
      sessionId: 'live-session',
      serviceId: 'happier.agent.codex/openai-codex',
      groupId: 'team',
    });
  });

  it('applies direct credential revisions only for bindings present in the live registry snapshot', async () => {
    const applyLiveCredentialRevision = vi.fn(async () => {});
    await expect(reconcileConnectedServiceDirectCredentialRevisions({
      credentialRevisions: [{
        serviceId: 'happier.agent.codex/openai-codex',
        profileId: 'direct',
        credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
      }],
      listRuntimeTargets: () => [{
        sessionId: 'live-session',
        connectedServicesBindingsRaw: {
          v: 2,
          bindingsByServiceId: {
            'happier.agent.codex/openai-codex': { source: 'connected', profileId: 'direct' },
          },
        },
        activeBindings: [],
      }],
      applyLiveCredentialRevision,
      resolveCredentialPresence: revisionedCredentialPresence,
      executionAuthority,
    })).resolves.toEqual({ acknowledgeable: true, pendingSessionCount: 0, appliedBindingCount: 1 });

    expect(applyLiveCredentialRevision).toHaveBeenCalledOnce();
  });

  it('routes authoritative deletion while leaving present legacy-unfenced bindings untouched', async () => {
    const applyLiveCredentialRevision = vi.fn(async () => {});
    await expect(reconcileConnectedServiceDirectCredentialRevisions({
      credentialRevisions: [],
      resolveCredentialPresence: (_serviceId, profileId) => (
        profileId === 'deleted'
          ? { status: 'absent' as const }
          : { status: 'legacy_unfenced' as const }
      ),
      listRuntimeTargets: () => [{
        sessionId: 'live-session',
        connectedServicesBindingsRaw: {
          v: 2,
          bindingsByServiceId: {
            'happier.agent.codex/openai-codex': { source: 'connected', profileId: 'deleted' },
            'happier.agent.claude/anthropic': { source: 'connected', profileId: 'legacy' },
          },
        },
        activeBindings: [],
      }],
      applyLiveCredentialRevision,
      executionAuthority,
    })).resolves.toEqual({ acknowledgeable: true, pendingSessionCount: 0, appliedBindingCount: 1 });

    expect(applyLiveCredentialRevision).toHaveBeenCalledWith({
      serviceId: 'happier.agent.codex/openai-codex',
      profileId: 'deleted',
      credentialPresence: { status: 'absent' },
      executionAuthority,
    });
  });
});
