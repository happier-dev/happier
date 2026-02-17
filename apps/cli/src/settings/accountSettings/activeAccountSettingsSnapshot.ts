import type { AccountSettings } from '@happier-dev/protocol';

export type ActiveAccountSettingsSnapshot = Readonly<{
  source: 'network' | 'cache' | 'none';
  settings: AccountSettings;
  settingsVersion: number;
  loadedAtMs: number;
}>;

let active: ActiveAccountSettingsSnapshot | null = null;

export function setActiveAccountSettingsSnapshot(next: ActiveAccountSettingsSnapshot): void {
  active = next;
}

export function getActiveAccountSettingsSnapshot(): ActiveAccountSettingsSnapshot | null {
  return active;
}

