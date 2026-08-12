import { describe, expect, it } from 'vitest';

import { resolveAgentProbeVariant } from './resolveAgentProbeVariant';

describe('resolveAgentProbeVariant', () => {
  it('partitions the Claude models probe cache by connected account', () => {
    const profileA = resolveAgentProbeVariant({
      agentId: 'claude',
      connectedServices: {
        v: 1,
        bindingsByServiceId: {
          'claude-subscription': { source: 'connected', selection: 'profile', profileId: 'profile-a' },
        },
      },
    });
    const profileB = resolveAgentProbeVariant({
      agentId: 'claude',
      connectedServices: {
        v: 1,
        bindingsByServiceId: {
          'claude-subscription': { source: 'connected', selection: 'profile', profileId: 'profile-b' },
        },
      },
    });
    const native = resolveAgentProbeVariant({ agentId: 'claude', connectedServices: null });

    // Each account probes its own model list, so they must never share a cache entry.
    expect(new Set([profileA, profileB, native]).size).toBe(3);
  });

  it('returns a stable variant for an equivalent binding', () => {
    const binding = {
      v: 1 as const,
      bindingsByServiceId: {
        'claude-subscription': { source: 'connected' as const, selection: 'profile' as const, profileId: 'profile-a' },
      },
    };

    // A variant that changed per call would pass the separation assertions above while silently
    // disabling cache reuse.
    expect(resolveAgentProbeVariant({ agentId: 'claude', connectedServices: binding }))
      .toBe(resolveAgentProbeVariant({ agentId: 'claude', connectedServices: binding }));
  });

  it('partitions the Claude models probe cache by group binding', () => {
    const group = resolveAgentProbeVariant({
      agentId: 'claude',
      connectedServices: {
        v: 1,
        bindingsByServiceId: {
          'claude-subscription': { source: 'connected', selection: 'group', groupId: 'group-a' },
        },
      },
    });
    const profile = resolveAgentProbeVariant({
      agentId: 'claude',
      connectedServices: {
        v: 1,
        bindingsByServiceId: {
          'claude-subscription': { source: 'connected', selection: 'profile', profileId: 'group-a' },
        },
      },
    });

    expect(group).not.toBe(profile);
  });
});
