import { describe, expect, it } from 'vitest';

import { resolveTabBarTabs } from './resolveTabBarTabs';

describe('resolveTabBarTabs', () => {
  it('returns inbox, sessions, friends, settings when both enabled', () => {
    expect(resolveTabBarTabs({ inboxEnabled: true, friendsEnabled: true })).toEqual([
      'inbox',
      'sessions',
      'friends',
      'settings',
    ]);
  });

  it('omits friends tab when friends disabled', () => {
    expect(resolveTabBarTabs({ inboxEnabled: true, friendsEnabled: false })).toEqual([
      'inbox',
      'sessions',
      'settings',
    ]);
  });

  it('omits inbox tab when inbox disabled', () => {
    expect(resolveTabBarTabs({ inboxEnabled: false, friendsEnabled: true })).toEqual([
      'sessions',
      'friends',
      'settings',
    ]);
  });

  it('returns sessions and settings when both disabled', () => {
    expect(resolveTabBarTabs({ inboxEnabled: false, friendsEnabled: false })).toEqual([
      'sessions',
      'settings',
    ]);
  });
});

