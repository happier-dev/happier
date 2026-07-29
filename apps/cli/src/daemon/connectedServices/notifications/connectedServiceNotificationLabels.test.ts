import { describe, expect, it } from 'vitest';

import { resolveConnectedServiceNotificationProfileLabel } from './connectedServiceNotificationLabels';

describe('resolveConnectedServiceNotificationProfileLabel', () => {
  it('does not expose provider account ids as public profile labels', () => {
    const profilesById = new Map([
      ['profile-local-safe', {
        profileId: 'profile-local-safe',
        displayName: null,
        providerEmail: null,
        providerAccountId: 'acct-provider-secret',
      }],
    ]);

    const label = resolveConnectedServiceNotificationProfileLabel(profilesById, 'profile-local-safe');

    expect(label).toBe('profile-local-safe');
    expect(label).not.toBe('acct-provider-secret');
  });
});
