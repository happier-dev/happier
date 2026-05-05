import type { AccountSettings } from '@happier-dev/protocol';

export type ActiveAccountSettingsSnapshot = Readonly<{
  source: 'network' | 'cache' | 'none';
  settings: AccountSettings;
  settingsVersion: number;
  loadedAtMs: number;
  settingsSecretsReadKeys: readonly Uint8Array[];
}>;

export type ActiveAccountSettingsSnapshotListener = (snapshot: ActiveAccountSettingsSnapshot | null) => void;

let active: ActiveAccountSettingsSnapshot | null = null;
const listeners = new Set<ActiveAccountSettingsSnapshotListener>();

function emitActiveAccountSettingsSnapshot(next: ActiveAccountSettingsSnapshot | null): void {
  for (const listener of listeners) {
    listener(next);
  }
}

export function setActiveAccountSettingsSnapshot(next: ActiveAccountSettingsSnapshot): void {
  active = next;
  emitActiveAccountSettingsSnapshot(active);
}

export function getActiveAccountSettingsSnapshot(): ActiveAccountSettingsSnapshot | null {
  return active;
}

export function subscribeActiveAccountSettingsSnapshot(listener: ActiveAccountSettingsSnapshotListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
