import type { AccountSettings } from '@happier-dev/protocol';

export type ActiveAccountSettingsSnapshot = Readonly<{
  source: 'network' | 'cache' | 'none';
  settings: AccountSettings;
  rawSettings?: Readonly<Record<string, unknown>>;
  settingsVersion: number;
  loadedAtMs: number;
  settingsSecretsReadKeys: readonly Uint8Array[];
  scopeKey?: string;
}>;

export type ActiveAccountSettingsSnapshotListener = (
  previous: ActiveAccountSettingsSnapshot | null,
  next: ActiveAccountSettingsSnapshot | null,
) => void;

export type ActiveAccountSettingsSnapshotCommit = Readonly<{
  snapshot: ActiveAccountSettingsSnapshot;
  didCommit: boolean;
}>;

let active: ActiveAccountSettingsSnapshot | null = null;
// This token is intentionally owner-local: it advances at Account lifetime
// boundaries, not when the active Account receives a newer settings revision.
let activeLifetimeToken = 0;
const listeners = new Set<ActiveAccountSettingsSnapshotListener>();

function belongsToSameAccount(
  previous: ActiveAccountSettingsSnapshot,
  next: ActiveAccountSettingsSnapshot,
): boolean {
  if (previous.scopeKey && next.scopeKey) {
    return previous.scopeKey === next.scopeKey;
  }
  // An unscoped replacement cannot prove that it belongs to the same Account.
  return previous === next;
}

function emitActiveAccountSettingsSnapshot(
  previous: ActiveAccountSettingsSnapshot | null,
  next: ActiveAccountSettingsSnapshot | null,
): void {
  for (const listener of listeners) {
    try {
      listener(previous, next);
    } catch {
      // The accepted local winner must not roll back because a consumer wake failed.
    }
  }
}

/** The sole process-local publication cut for account settings. */
export function commitActiveAccountSettingsSnapshot(
  next: ActiveAccountSettingsSnapshot,
): ActiveAccountSettingsSnapshotCommit {
  const previous = active;
  if (
    previous?.scopeKey
    && next.scopeKey === previous.scopeKey
    && next.settingsVersion <= previous.settingsVersion
  ) {
    return { snapshot: previous, didCommit: false };
  }
  active = next;
  if (!previous || !belongsToSameAccount(previous, next)) {
    activeLifetimeToken += 1;
  }
  emitActiveAccountSettingsSnapshot(previous, next);
  return { snapshot: next, didCommit: true };
}

export function setActiveAccountSettingsSnapshot(next: ActiveAccountSettingsSnapshot): void {
  commitActiveAccountSettingsSnapshot(next);
}

export function getActiveAccountSettingsSnapshot(): ActiveAccountSettingsSnapshot | null {
  return active;
}

/**
 * Identifies the current process-local Account incumbent.  Consumers that bind
 * authority across async work must capture this token, rather than treating a
 * matching scope key as proof that a retired Account lifetime is current again.
 */
export function getActiveAccountSettingsSnapshotLifetimeToken(): number {
  return activeLifetimeToken;
}

/**
 * Revokes the current process-local Account Settings incumbent at logout.
 * Subscribers observe this transition so custody bound to the prior Account
 * cannot become current again if that Account is later selected anew.
 */
export function clearActiveAccountSettingsSnapshot(): void {
  const previous = active;
  if (!previous) return;
  active = null;
  activeLifetimeToken += 1;
  emitActiveAccountSettingsSnapshot(previous, null);
}

export function resolveActiveAccountSettingsSnapshotRevision(
  snapshot: ActiveAccountSettingsSnapshot | null,
): string {
  if (!snapshot) return 'account-profile:bootstrap';
  return [
    snapshot.scopeKey ?? 'active',
    snapshot.settingsVersion,
    snapshot.loadedAtMs,
  ].join(':');
}

export function resetActiveAccountSettingsSnapshotForTests(): void {
  const previous = active;
  active = null;
  if (previous) activeLifetimeToken += 1;
}

export function subscribeActiveAccountSettingsSnapshot(listener: ActiveAccountSettingsSnapshotListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
