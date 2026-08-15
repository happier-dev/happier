import { afterEach, describe, expect, it } from 'vitest';

import {
  getBrokerBridgeEffectiveSelectionForTest,
  resetBrokerBridgeEffectiveSelectionsForTests,
} from '@/daemon/connectedServices/broker/brokerBridgeEffectiveSelectionRegistry';
import { createPiConnectedServiceRuntimeAuthAdapter } from './createPiConnectedServiceRuntimeAuthAdapter';

describe('createPiConnectedServiceRuntimeAuthAdapter', () => {
  afterEach(() => {
    resetBrokerBridgeEffectiveSelectionsForTests();
  });

  it('classifies Pi assistant usage-limit messages for the matching connected-service group', () => {
    const adapter = createPiConnectedServiceRuntimeAuthAdapter();

    const classification = adapter.classifyRuntimeAuthFailure({
      target: { agentId: 'pi', targetId: 'pi-session-1' },
      error: {
        provider: 'anthropic',
        message: {
          role: 'assistant',
          provider: 'anthropic',
          stopReason: 'error',
          errorMessage: 'Usage limit reached. Please try again in 2m30s.',
        },
      },
      selection: new Map([
        ['claude-subscription', {
          kind: 'group',
          serviceId: 'claude-subscription',
          groupId: 'claude-main',
          activeProfileId: 'claude-primary',
          fallbackProfileId: 'claude-backup',
          generation: 3,
        }],
      ]),
    });

    expect(classification).toMatchObject({
      kind: 'usage_limit',
      limitCategory: 'usage_limit',
      serviceId: 'claude-subscription',
      profileId: 'claude-primary',
      groupId: 'claude-main',
      retryAfterMs: 150_000,
      quotaScope: 'account',
      source: 'stable_provider_message',
    });
  });

  it('classifies encoded assistant content usage-limit messages for the matching Codex group', () => {
    const adapter = createPiConnectedServiceRuntimeAuthAdapter();

    const classification = adapter.classifyRuntimeAuthFailure({
      target: { agentId: 'pi', targetId: 'pi-session-1' },
      error: {
        provider: 'openai-codex',
        message: {
          role: 'assistant',
          provider: 'openai-codex',
          stopReason: 'error',
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                type: 'usage_limit_reached',
                errorMessage: 'Usage limit reached',
              }),
            },
          ],
        },
      },
      selection: new Map([
        ['openai-codex', {
          kind: 'group',
          serviceId: 'openai-codex',
          groupId: 'happier',
          activeProfileId: 'leeroy',
          fallbackProfileId: 'backup',
          generation: 3,
        }],
      ]),
    });

    expect(classification).toMatchObject({
      kind: 'usage_limit',
      limitCategory: 'usage_limit',
      serviceId: 'openai-codex',
      profileId: 'leeroy',
      groupId: 'happier',
      quotaScope: 'account',
      source: 'stable_provider_message',
    });
  });

  it('classifies Pi auth failures against OpenAI API-key selections', () => {
    const adapter = createPiConnectedServiceRuntimeAuthAdapter();

    const classification = adapter.classifyRuntimeAuthFailure({
      target: { agentId: 'pi' },
      error: { provider: 'openai', message: 'No API key found for provider: openai' },
      selection: {
        kind: 'profile',
        serviceId: 'openai',
        profileId: 'openai-work',
      },
    });

    expect(classification).toMatchObject({
      kind: 'auth_expired',
      limitCategory: 'auth_invalid',
      serviceId: 'openai',
      profileId: 'openai-work',
      groupId: null,
      source: 'stable_provider_message',
    });
  });

  it('classifies Pi dependency-scoped compaction failures distinctly from usage limits', () => {
    const adapter = createPiConnectedServiceRuntimeAuthAdapter();

    const classification = adapter.classifyRuntimeAuthFailure({
      target: { agentId: 'pi', targetId: 'pi-session-1' },
      error: {
        provider: 'anthropic',
        event: {
          type: 'compaction_end',
          reason: 'overflow',
          willRetry: false,
          errorMessage: 'Context compaction dependency failed: claude executable missing.',
        },
      },
      selection: new Map([
        ['claude-subscription', {
          kind: 'group',
          serviceId: 'claude-subscription',
          groupId: 'claude-main',
          activeProfileId: 'claude-primary',
          fallbackProfileId: 'claude-backup',
          generation: 3,
        }],
      ]),
    });

    expect(classification).toMatchObject({
      kind: 'dependency_failure',
      serviceId: 'claude-subscription',
      profileId: 'claude-primary',
      groupId: 'claude-main',
      source: 'stable_provider_message',
    });
    expect(classification?.limitCategory).toBeUndefined();
  });

  it('does not attribute untagged provider errors to the first selection when multiple selections are active', () => {
    const adapter = createPiConnectedServiceRuntimeAuthAdapter();

    const classification = adapter.classifyRuntimeAuthFailure({
      target: { agentId: 'pi', targetId: 'pi-session-1' },
      error: {
        message: {
          role: 'assistant',
          stopReason: 'error',
          errorMessage: 'Usage limit reached. Please try again later.',
        },
      },
      selection: new Map([
        ['openai-codex', {
          kind: 'group',
          serviceId: 'openai-codex',
          groupId: 'openai-main',
          activeProfileId: 'openai-primary',
          fallbackProfileId: 'openai-backup',
          generation: 3,
        }],
        ['claude-subscription', {
          kind: 'group',
          serviceId: 'claude-subscription',
          groupId: 'claude-main',
          activeProfileId: 'claude-primary',
          fallbackProfileId: 'claude-backup',
          generation: 4,
        }],
      ]),
    });

    expect(classification).toBeNull();
  });

  it('reports restart-rematerialize adoption as weakly_verified — no live provider probe runs (RD-OPI-8)', async () => {
    const adapter = createPiConnectedServiceRuntimeAuthAdapter();

    await expect(adapter.verifyActiveAccount?.({
      target: { agentId: 'pi' },
      selection: {},
    })).resolves.toEqual({
      status: 'weakly_verified',
      reason: 'provider_restart_rematerialization_authoritative',
    });
  });

  it('preserves the Pi process after a broker-owned auth switch', async () => {
    const adapter = createPiConnectedServiceRuntimeAuthAdapter();

    await expect(adapter.recoverAfterRuntimeAuthSwitch({
      target: { agentId: 'pi' },
      selection: {
        serviceId: 'openai-codex',
        brokerSelectionIdentity: 'pi|connected|broker:1|openai-codex:acct-old:',
      },
    })).resolves.toEqual({
      recovered: true,
      recovery: 'provider_owned_broker_selection',
      detached: false,
      detachedReason: 'broker_request_time_selection_preserved',
    });
  });

  it('declines in-place recovery without request-time broker ownership', async () => {
    const adapter = createPiConnectedServiceRuntimeAuthAdapter();

    await expect(adapter.recoverAfterRuntimeAuthSwitch({
      target: { agentId: 'pi' },
      selection: { serviceId: 'openai-codex' },
    })).resolves.toEqual({
      recovered: false,
      recovery: 'restart_rematerialize',
      detached: false,
      detachedReason: 'broker_selection_identity_missing',
    });
  });

  it('hot-applies a brokered member switch with exact generation/revision proof', async () => {
    const adapter = createPiConnectedServiceRuntimeAuthAdapter();

    expect(adapter.canHotApply({
      target: { agentId: 'pi' },
      selection: {
        brokerSelectionIdentity: 'pi|connected|broker:1|claude-subscription:acct-old:',
      },
    })).toEqual({ supported: true, recovery: 'provider_owned_broker_selection' });

    await expect(adapter.hotApply({
      target: { agentId: 'pi' },
      selection: {
        serviceId: 'claude-subscription',
        brokerSelectionIdentity: 'pi|connected|broker:1|claude-subscription:acct-old:',
        kind: 'group',
        groupId: 'main',
        activeProfileId: 'profile-new',
        fallbackProfileId: 'profile-old',
        generation: 12,
        credentialRevision: 'rev-new',
        record: {
          kind: 'oauth',
          serviceId: 'claude-subscription',
          profileId: 'profile-new',
          oauth: { accessToken: 'access-new', providerAccountId: 'acct-new' },
        },
      },
    })).resolves.toMatchObject({
      applied: true,
      recovery: 'provider_owned_broker_selection',
      verification: {
        status: 'verified',
        proofStrength: 'exact',
        providerAccountId: 'acct-new',
        credentialRevision: 'rev-new',
        generationApplication: {
          serviceId: 'claude-subscription',
          groupId: 'main',
          profileId: 'profile-new',
          generation: 12,
          credentialRevision: 'rev-new',
        },
      },
    });

    expect(getBrokerBridgeEffectiveSelectionForTest({
      selectionIdentity: 'pi|connected|broker:1|claude-subscription:acct-old:',
      serviceId: 'claude-subscription',
    })).toMatchObject({
      selectionEpoch: 1,
      selection: {
        activeProfileId: 'profile-new',
        credentialRevision: 'rev-new',
      },
    });
  });

  it('keeps unbrokered Pi restart-only', () => {
    const adapter = createPiConnectedServiceRuntimeAuthAdapter();
    expect(adapter.canHotApply({ target: { agentId: 'pi' }, selection: { serviceId: 'openai' } }))
      .toEqual({ supported: false, recovery: 'restart_rematerialize' });
  });
});
