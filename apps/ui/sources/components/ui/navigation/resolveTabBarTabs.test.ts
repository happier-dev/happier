import { describe, expect, it } from 'vitest';

import { resolveTabBarTabs } from './resolveTabBarTabs';

describe('resolveTabBarTabs', () => {
  it('returns settings, friends, projects, sessions, inbox when both enabled', () => {
    expect(resolveTabBarTabs({ inboxEnabled: true, friendsEnabled: true })).toEqual([
      'settings',
      'friends',
      'projects',
      'sessions',
      'inbox',
    ]);
  });

  it('omits friends tab when friends disabled', () => {
    expect(resolveTabBarTabs({ inboxEnabled: true, friendsEnabled: false })).toEqual([
      'settings',
      'projects',
      'sessions',
      'inbox',
    ]);
  });

  it('omits inbox tab when inbox disabled', () => {
    expect(resolveTabBarTabs({ inboxEnabled: false, friendsEnabled: true })).toEqual([
      'settings',
      'friends',
      'projects',
      'sessions',
    ]);
  });

  it('returns sessions and settings when both disabled', () => {
    expect(resolveTabBarTabs({ inboxEnabled: false, friendsEnabled: false })).toEqual([
      'settings',
      'projects',
      'sessions',
    ]);
  });
});
