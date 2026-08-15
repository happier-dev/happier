import { describe, expect, it } from 'vitest';

import { PI_BROKER_SELECTIONS_ENV, serializePiBrokerSelections } from '@/backends/pi/brokerExtension';
import { agent } from './index';

describe('Pi connected-service credential lifecycle descriptor', () => {
  it('advertises provider-owned broker hot apply without enabling predictive or in-turn switching', async () => {
    await expect(agent.getConnectedServiceCredentialLifecycleDescriptor()).resolves.toMatchObject({
      providerId: 'pi',
      refreshedCredentialApplication: {
        mode: 'restart_required',
        // openai-codex is OAuth-only ⇒ always brokered ⇒ unconditional no-restart. claude-subscription
        // is credential-shape-specific (OAuth = brokered/no-restart; setup-token = raw api_key baked at
        // spawn ⇒ restart-required), so it must NOT claim unconditional no-restart.
        noRestartRequiredServiceIds: ['openai-codex'],
        noRestartRequiredWhenBrokeredServiceIds: ['claude-subscription'],
      },
      sameAccountFanoutStrategy: 'shared_group_auth_surface',
      predictiveSoftSwitch: { mode: 'unsupported' },
      runtimeAuthApply: {
        directLiveHotAuth: {
          supportsInTurnApply: false,
          requiresExactRuntimeIdentity: false,
          refreshSelectionResync: 'not_applicable',
          authMode: {
            kind: 'provider_owned',
            name: 'broker_selection_indirection',
          },
        },
      },
    });
  });

  it('reports a claude-subscription setup-token session as NOT broker-backed (needs restart)', async () => {
    const descriptor = await agent.getConnectedServiceCredentialLifecycleDescriptor();
    const isBrokered = descriptor.refreshedCredentialApplication.isTargetBrokeredForBinding;
    expect(isBrokered).toBeTypeOf('function');
    // A setup-token materializes as a raw api_key with no broker env at all.
    expect(isBrokered?.({ serviceId: 'claude-subscription', environmentVariables: {} })).toBe(false);
  });

  it('reports a claude-subscription OAuth (brokered) session as broker-backed (no restart)', async () => {
    const descriptor = await agent.getConnectedServiceCredentialLifecycleDescriptor();
    const isBrokered = descriptor.refreshedCredentialApplication.isTargetBrokeredForBinding;
    const environmentVariables = {
      [PI_BROKER_SELECTIONS_ENV]: serializePiBrokerSelections({
        anthropic: { serviceId: 'claude-subscription', profileId: 'work', accountId: null, planType: null },
      }),
    };
    expect(isBrokered?.({ serviceId: 'claude-subscription', environmentVariables })).toBe(true);
    // A session brokered ONLY for openai-codex is not broker-backed for claude-subscription.
    const codexOnly = {
      [PI_BROKER_SELECTIONS_ENV]: serializePiBrokerSelections({
        openai: { serviceId: 'openai-codex', profileId: 'work', accountId: null, planType: null },
      }),
    };
    expect(isBrokered?.({ serviceId: 'claude-subscription', environmentVariables: codexOnly })).toBe(false);
  });
});
