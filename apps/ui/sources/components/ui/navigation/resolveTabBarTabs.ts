import type { TabType } from './tabTypes';

export type ResolveTabBarTabsInput = Readonly<{
  inboxEnabled: boolean;
  friendsEnabled: boolean;
}>;

export function resolveTabBarTabs(input: ResolveTabBarTabsInput): TabType[] {
  const tabs: TabType[] = [];

  tabs.push('settings');
  if (input.friendsEnabled) tabs.push('friends');
  tabs.push('projects');
  tabs.push('sessions');
  if (input.inboxEnabled) tabs.push('inbox');

  return tabs;
}
