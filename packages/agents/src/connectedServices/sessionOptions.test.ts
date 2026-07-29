import { describe, expect, it } from 'vitest';

import {
  buildConnectedServiceAccountGroupOptionsByServiceId,
  resolveConnectedServiceSessionSelection,
} from './sessionOptions.js';

const profiles = [
  { profileId: 'primary', status: 'connected' as const },
  { profileId: 'reauth', status: 'needs_reauth' as const },
];

describe('resolveConnectedServiceSessionSelection', () => {
  it('distinguishes no connected selection from a valid connected profile', () => {
    expect(resolveConnectedServiceSessionSelection({
      binding: { source: 'native' },
      availability: { kind: 'known', profileOptions: profiles, groupOptions: [], accountGroupsEnabled: true },
      serviceId: 'anthropic',
      defaultProfileByServiceId: {},
    })).toEqual({ status: 'no_selection' });

    expect(resolveConnectedServiceSessionSelection({
      binding: { source: 'connected', selection: 'profile', profileId: 'primary' },
      availability: { kind: 'known', profileOptions: profiles, groupOptions: [], accountGroupsEnabled: true },
      serviceId: 'anthropic',
      defaultProfileByServiceId: {},
    })).toEqual({
      status: 'valid_selection',
      selection: { selection: 'profile', profileId: 'primary' },
    });
  });

  it('preserves the requested identity when an explicit profile or group is unavailable', () => {
    expect(resolveConnectedServiceSessionSelection({
      binding: { source: 'connected', selection: 'profile', profileId: 'reauth' },
      availability: { kind: 'known', profileOptions: profiles, groupOptions: [], accountGroupsEnabled: true },
      serviceId: 'anthropic',
      defaultProfileByServiceId: {},
    })).toEqual({
      status: 'explicit_unavailable',
      selection: { selection: 'profile', profileId: 'reauth' },
      reason: 'profile_unavailable',
    });

    expect(resolveConnectedServiceSessionSelection({
      binding: { source: 'connected', selection: 'group', groupId: 'team' },
      availability: {
        kind: 'known',
        profileOptions: profiles,
        groupOptions: [{
          groupId: 'team',
          label: 'Team',
          activeProfileId: null,
          enabledMemberCount: 2,
          autoSwitch: true,
          status: 'ready',
        }],
        accountGroupsEnabled: true,
      },
      serviceId: 'anthropic',
      defaultProfileByServiceId: {},
    })).toEqual({
      status: 'explicit_unavailable',
      selection: { selection: 'group', groupId: 'team' },
      reason: 'group_active_profile_unavailable',
    });
  });

  it('defers availability without discarding an exact connected selection', () => {
    expect(resolveConnectedServiceSessionSelection({
      binding: { source: 'connected', selection: 'group', groupId: 'team' },
      availability: { kind: 'deferred' },
      serviceId: 'anthropic',
    })).toEqual({
      status: 'valid_selection',
      selection: { selection: 'group', groupId: 'team' },
    });
  });

  it('retains a durable null-active group in the shared option projection', () => {
    expect(buildConnectedServiceAccountGroupOptionsByServiceId({
      accountGroupsFeatureEnabled: true,
      supportedConnectedServiceIds: ['anthropic'],
      accountProfileConnectedServicesV2: [{
        serviceId: 'anthropic',
        groups: [{
          groupId: 'team',
          displayName: 'Team',
          activeProfileId: null,
          memberProfileIds: ['primary', 'backup'],
        }],
      }],
    })).toEqual({
      anthropic: [{
        groupId: 'team',
        label: 'Team',
        activeProfileId: null,
        memberProfileIds: ['primary', 'backup'],
        enabledMemberCount: 2,
        autoSwitch: false,
        status: 'ready',
      }],
    });
  });
});
