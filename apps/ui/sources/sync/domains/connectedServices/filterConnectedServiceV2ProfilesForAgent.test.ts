import { describe, expect, it } from 'vitest';

import type { AgentCore } from '@happier-dev/agents';

import { filterConnectedServiceV2ProfilesForAgent } from './filterConnectedServiceV2ProfilesForAgent';

describe('filterConnectedServiceV2ProfilesForAgent', () => {
  it('filters connected profiles by allowed kinds when configured', () => {
    const agentCore: AgentCore = {
      id: 'pi',
      cliSubcommand: 'pi',
      detectKey: 'pi',
      connectedServices: {
        supportedServiceIds: ['openai-codex', 'anthropic'],
        supportedKindsByServiceId: {
          anthropic: ['token'],
        },
      },
      resume: { vendorResume: 'unsupported', vendorResumeIdField: null, runtimeGate: null },
    };

    const profiles = [
      { profileId: 'work', status: 'connected' as const, kind: 'oauth' as const },
      { profileId: 'personal', status: 'connected' as const, kind: 'token' as const },
      { profileId: 'reauth', status: 'needs_reauth' as const, kind: null },
    ];

    const filtered = filterConnectedServiceV2ProfilesForAgent({
      agentCore,
      serviceId: 'anthropic',
      profiles,
    });

    expect(filtered.map((p) => p.profileId)).toEqual(['personal', 'reauth']);
  });

  it('does not filter when no allowed-kinds mapping exists for the service', () => {
    const agentCore: AgentCore = {
      id: 'pi',
      cliSubcommand: 'pi',
      detectKey: 'pi',
      connectedServices: {
        supportedServiceIds: ['openai-codex', 'anthropic'],
      },
      resume: { vendorResume: 'unsupported', vendorResumeIdField: null, runtimeGate: null },
    };

    const profiles = [
      { profileId: 'work', status: 'connected' as const, kind: 'oauth' as const },
      { profileId: 'personal', status: 'connected' as const, kind: 'token' as const },
    ];

    const filtered = filterConnectedServiceV2ProfilesForAgent({
      agentCore,
      serviceId: 'anthropic',
      profiles,
    });

    expect(filtered.map((p) => p.profileId)).toEqual(['work', 'personal']);
  });
});

