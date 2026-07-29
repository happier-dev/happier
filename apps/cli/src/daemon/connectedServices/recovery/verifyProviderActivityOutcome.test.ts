import { describe, expect, it, vi } from 'vitest';

import { verifyProviderActivityOutcome } from './verifyProviderActivityOutcome';

const RAW_SELECTIONS = JSON.stringify([{
  kind: 'group',
  serviceId: 'gemini',
  groupId: 'pool',
  activeProfileId: 'work',
  fallbackProfileId: 'backup',
  generation: 7,
  credentialRevision: 'csr_abcdefghijklmnopqrstuv',
}]);

type VerificationTarget = Parameters<typeof verifyProviderActivityOutcome>[0]['target'];

function target(): VerificationTarget {
  return {
    agentId: 'gemini',
    runtimeIdentityKey: 'runtime-identity',
    connectedServiceSelectionsEnv: {
      HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: RAW_SELECTIONS,
    },
    connectedServiceSelections: JSON.parse(RAW_SELECTIONS),
  };
}

describe('verifyProviderActivityOutcome', () => {
  it('accepts exact child-envelope activity through the projected provider adapter', async () => {
    const verifyProviderOutcome = vi.fn(async () => ({
      status: 'verified' as const,
      source: 'gemini_provider_activity',
      targets: [{
        serviceId: 'gemini',
        profileId: 'work',
        groupId: 'pool',
        groupGeneration: 7,
        credentialRevision: 'csr_abcdefghijklmnopqrstuv',
      }],
    }));

    await expect(verifyProviderActivityOutcome({
      target: target(),
      reportedSelectionsEnvRaw: RAW_SELECTIONS,
      event: 'task_started',
      loadAdapter: async () => ({ verifyProviderOutcome } as never),
    })).resolves.toEqual({
      status: 'verified',
      targets: [{
        serviceId: 'gemini',
        profileId: 'work',
        groupId: 'pool',
        groupGeneration: 7,
        credentialRevision: 'csr_abcdefghijklmnopqrstuv',
      }],
    });
    expect(verifyProviderOutcome).toHaveBeenCalledWith(expect.objectContaining({
      selections: target().connectedServiceSelections,
      outcome: { kind: 'provider_activity', event: 'task_started' },
    }));
  });

  it('invokes the real projected Gemini, Antigravity, and OhMyPi provider adapters', async () => {
    const cases = [
      {
        agentId: 'gemini',
        selections: JSON.parse(RAW_SELECTIONS),
        expectedServiceIds: ['gemini'],
      },
      {
        agentId: 'antigravity',
        selections: [{
          kind: 'profile',
          serviceId: 'gemini',
          profileId: 'vertex-work',
          credentialRevision: 'csr_abcdefghijklmnopqrstuv',
        }],
        expectedServiceIds: ['gemini'],
      },
      {
        agentId: 'ohMyPi',
        selections: [
          ['openai-codex', 'codex-work', 'csr_abcdefghijklmnopqrstuv'],
          ['openai', 'openai-work', 'csr_bcdefghijklmnopqrstuvw'],
          ['claude-subscription', 'claude-work', 'csr_cdefghijklmnopqrstuvwx'],
          ['anthropic', 'anthropic-work', 'csr_defghijklmnopqrstuvwxy'],
          ['gemini', 'gemini-work', 'csr_efghijklmnopqrstuvwxyz'],
        ].map(([serviceId, profileId, credentialRevision]) => ({
          kind: 'profile', serviceId, profileId, credentialRevision,
        })),
        expectedServiceIds: ['openai-codex', 'openai', 'claude-subscription', 'anthropic', 'gemini'],
      },
    ] as const;

    for (const providerCase of cases) {
      const raw = JSON.stringify(providerCase.selections);
      const result = await verifyProviderActivityOutcome({
        target: {
          ...target(),
          agentId: providerCase.agentId,
          connectedServiceSelectionsEnv: { HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: raw },
          connectedServiceSelections: providerCase.selections as VerificationTarget['connectedServiceSelections'],
        },
        reportedSelectionsEnvRaw: raw,
        event: 'assistant_message_end',
      });

      expect(result.status).toBe('verified');
      expect(result.status === 'verified'
        ? result.targets.map((outcomeTarget) => outcomeTarget.serviceId)
        : []).toEqual(providerCase.expectedServiceIds);
    }
  });

  it('rejects a delayed old-process envelope before entering provider mechanics', async () => {
    const verifyProviderOutcome = vi.fn();
    await expect(verifyProviderActivityOutcome({
      target: target(),
      reportedSelectionsEnvRaw: JSON.stringify([{ kind: 'profile', serviceId: 'gemini', profileId: 'old' }]),
      event: 'task_started',
      loadAdapter: async () => ({ verifyProviderOutcome } as never),
    })).resolves.toEqual({ status: 'unavailable', reason: 'runtime_selection_epoch_mismatch' });
    expect(verifyProviderOutcome).not.toHaveBeenCalled();
  });

  it('rejects a mixed-epoch OhMyPi envelope atomically', async () => {
    const selections = [
      ['openai-codex', 'codex-work', 'csr_abcdefghijklmnopqrstuv'],
      ['openai', 'openai-work', 'csr_bcdefghijklmnopqrstuvw'],
      ['claude-subscription', 'claude-work', 'csr_cdefghijklmnopqrstuvwx'],
      ['anthropic', 'anthropic-work', 'csr_defghijklmnopqrstuvwxy'],
      ['gemini', 'gemini-work', 'csr_efghijklmnopqrstuvwxyz'],
    ].map(([serviceId, profileId, credentialRevision]) => ({
      kind: 'profile', serviceId, profileId, credentialRevision,
    }));
    const registeredRaw = JSON.stringify(selections);
    const reportedRaw = JSON.stringify(selections.map((selection) => selection.serviceId === 'gemini'
      ? { ...selection, credentialRevision: 'csr_fghijklmnopqrstuvwxyz2' }
      : selection));

    await expect(verifyProviderActivityOutcome({
      target: {
        ...target(),
        agentId: 'ohMyPi',
        connectedServiceSelectionsEnv: { HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: registeredRaw },
        connectedServiceSelections: selections as VerificationTarget['connectedServiceSelections'],
      },
      reportedSelectionsEnvRaw: reportedRaw,
      event: 'assistant_message_end',
    })).resolves.toEqual({ status: 'unavailable', reason: 'runtime_selection_epoch_mismatch' });
  });

  it('rejects missing revisions and plugin results that do not match the running selection', async () => {
    const withoutRevision = JSON.stringify([{
      kind: 'profile', serviceId: 'gemini', profileId: 'work',
    }]);
    await expect(verifyProviderActivityOutcome({
      target: {
        ...target(),
        connectedServiceSelectionsEnv: { HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: withoutRevision },
        connectedServiceSelections: JSON.parse(withoutRevision),
      },
      reportedSelectionsEnvRaw: withoutRevision,
      event: 'task_started',
      loadAdapter: async () => ({
        verifyProviderOutcome: async () => ({ status: 'verified', targets: [] }),
      } as never),
    })).resolves.toMatchObject({ status: 'unavailable' });

    await expect(verifyProviderActivityOutcome({
      target: target(),
      reportedSelectionsEnvRaw: RAW_SELECTIONS,
      event: 'task_started',
      loadAdapter: async () => ({
        verifyProviderOutcome: async () => ({
          status: 'verified',
          targets: [{
            serviceId: 'gemini',
            profileId: 'work',
            groupId: 'pool',
            groupGeneration: 7,
            credentialRevision: 'csr_bcdefghijklmnopqrstuvw',
          }],
        }),
      } as never),
    })).resolves.toEqual({ status: 'unavailable', reason: 'provider_outcome_target_mismatch' });
  });
});
