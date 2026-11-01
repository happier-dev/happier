import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';

import { verifyProviderActivityOutcome } from './verifyProviderActivityOutcome';

const RAW_SELECTIONS = JSON.stringify([{
  kind: 'group',
  serviceId: 'happier.agent.gemini/gemini-account',
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
  let runtime: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>>;

  beforeAll(async () => {
    runtime = await createAdmittedPluginRuntimeFixture({
      controller: pluginReloadController,
      runtimeOptions: {
        pluginIds: ['happier.agent.gemini', 'happier.agent.antigravity'],
      },
    });
  });

  afterAll(async () => {
    try { await runtime?.dispose(); }
    finally { await pluginReloadController.shutdown(); }
  });

  it('accepts exact child-envelope activity through the projected provider adapter', async () => {
    const verifyProviderOutcome = vi.fn(async () => ({
      status: 'verified' as const,
      source: 'gemini_provider_activity',
      targets: [{
        serviceId: 'happier.agent.gemini/gemini-account',
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
        serviceId: 'happier.agent.gemini/gemini-account',
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

  it('invokes the real projected Gemini and Antigravity provider adapters', async () => {
    const cases = [
      {
        agentId: 'gemini',
        selections: JSON.parse(RAW_SELECTIONS),
        expectedServiceIds: ['happier.agent.gemini/gemini-account'],
      },
      {
        agentId: 'antigravity',
        selections: [{
          kind: 'profile',
          serviceId: 'happier.agent.antigravity/antigravity-account',
          profileId: 'vertex-work',
          credentialRevision: 'csr_abcdefghijklmnopqrstuv',
        }],
        expectedServiceIds: ['happier.agent.antigravity/antigravity-account'],
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

  it('rejects missing revisions and plugin results that do not match the running selection', async () => {
    const withoutRevision = JSON.stringify([{
      kind: 'profile', serviceId: 'happier.agent.gemini/gemini-account', profileId: 'work',
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
        verifyProviderOutcome: async () => ({
          status: 'verified',
          targets: [{
            serviceId: 'happier.agent.gemini/gemini-account',
            profileId: 'work',
            credentialRevision: 'csr_abcdefghijklmnopqrstuv',
          }],
        }),
      } as never),
    })).resolves.toEqual({ status: 'unavailable', reason: 'runtime_selection_revision_missing' });

    await expect(verifyProviderActivityOutcome({
      target: target(),
      reportedSelectionsEnvRaw: RAW_SELECTIONS,
      event: 'task_started',
      loadAdapter: async () => ({
        verifyProviderOutcome: async () => ({
          status: 'verified',
          targets: [{
            serviceId: 'happier.agent.gemini/gemini-account',
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
