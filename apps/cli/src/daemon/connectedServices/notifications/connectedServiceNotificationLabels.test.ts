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

    expect(label).toBe('Connected account');
    expect(label).not.toBe('acct-provider-secret');
  });

  it.each([
    { displayName: 'profile-internal', providerEmail: null, providerAccountId: null },
    { displayName: 'provider-internal', providerEmail: null, providerAccountId: 'provider-internal' },
    { displayName: 'ChatGPT', providerEmail: null, providerAccountId: null },
    { displayName: '   ', providerEmail: null, providerAccountId: null },
  ])('uses neutral copy for non-name evidence: $displayName', (profile) => {
    expect(resolveConnectedServiceNotificationProfileLabel(new Map([
      ['profile-internal', { profileId: 'profile-internal', ...profile }],
    ]), 'profile-internal', 'ChatGPT')).toBe('Connected account');
  });

  it('preserves human names and uses email when the stored name is an identifier', () => {
    const profiles = new Map([
      ['work', { profileId: 'work', displayName: 'Work account', providerEmail: 'work@example.test' }],
      ['personal', { profileId: 'personal', displayName: 'personal', providerEmail: 'me@example.test' }],
    ]);
    expect(resolveConnectedServiceNotificationProfileLabel(profiles, 'work', 'ChatGPT')).toBe('Work account');
    expect(resolveConnectedServiceNotificationProfileLabel(profiles, 'personal', 'ChatGPT')).toBe('me@example.test');
    expect(resolveConnectedServiceNotificationProfileLabel(profiles, 'missing-internal', 'ChatGPT')).toBe('Connected account');
    expect(resolveConnectedServiceNotificationProfileLabel(profiles, null, 'ChatGPT')).toBeNull();
  });
});
