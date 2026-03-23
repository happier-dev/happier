import type { TabType } from './tabTypes';

export type ResolveTabBarTabsInput = Readonly<{
  inboxEnabled: boolean;
  friendsEnabled: boolean;
}>;

export function resolveTabBarTabs(input: ResolveTabBarTabsInput): TabType[] {
  const tabs: TabType[] = [];

  if (input.inboxEnabled) tabs.push('inbox');
  tabs.push('sessions');
  if (input.friendsEnabled) tabs.push('friends');
  tabs.push('settings');

  return tabs;
}

