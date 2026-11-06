import { describe, expect, it } from 'vitest';

import { resolveTabBarTabs } from './resolveTabBarTabs';

// Owner Q4 (2026-10-30): the phone's tabs are Sessions, Projects, Inbox and Workflows; Settings opens
// from the avatar, and Friends from the shortcuts menu.
describe('resolveTabBarTabs', () => {
  it('returns Sessions, Projects, Inbox and Workflows when both are available', () => {
    expect(resolveTabBarTabs({ inboxEnabled: true, workflowsEnabled: true })).toEqual(['sessions', 'projects', 'inbox', 'workflows']);
  });

  it('omits each tab whose destination is unavailable', () => {
    expect(resolveTabBarTabs({ inboxEnabled: false, workflowsEnabled: true })).toEqual(['sessions', 'projects', 'workflows']);
    expect(resolveTabBarTabs({ inboxEnabled: true, workflowsEnabled: false })).toEqual(['sessions', 'projects', 'inbox']);
  });
});
