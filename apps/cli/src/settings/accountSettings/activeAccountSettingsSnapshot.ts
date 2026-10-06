import { projectSavedSecretCatalogCollisionStateV1 } from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';
import type { AccountSettings, SavedSecretCatalogCollisionStateV1 } from '@happier-dev/protocol';
import type {
  SavedSecretCatalogResourceInputV1,
  SavedSecretCatalogState,
} from '@/settings/secrets/savedSecretCatalog';

export type ActiveAccountSettingsSnapshot = Readonly<{
  source: 'network' | 'cache' | 'none';
  settings: AccountSettings;
  rawSettings?: Readonly<Record<string, unknown>>;
  settingsVersion: number;
  loadedAtMs: number;
  settingsSecretsReadKeys: readonly Uint8Array[];
  savedSecretResources?: readonly SavedSecretCatalogResourceInputV1[];
  savedSecretCatalogState?: SavedSecretCatalogState;
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
// The snapshot listeners last observed. It trails `active` only while a Saved
// Secret catalog refresh has withdrawn material without publishing, and after
// a refresh that observed a logically unchanged catalog.
let published: ActiveAccountSettingsSnapshot | null = null;
// This token is intentionally owner-local: it advances at Account lifetime
// boundaries, not when the active Account receives a newer settings revision.
let activeLifetimeToken = 0;
// Connected Services projections can change the configured External Session
// source set without changing Account Settings themselves.
let activeConnectedServicesProjectionRevision = 0;
const listeners = new Set<ActiveAccountSettingsSnapshotListener>();

function zeroRetiredSavedSecretResourceDataKeys(
  previous: readonly SavedSecretCatalogResourceInputV1[] | undefined,
  next: readonly SavedSecretCatalogResourceInputV1[] | undefined,
): void {
  if (!previous) return;
  const retainedKeys = new Set(
    (next ?? []).flatMap((resource) => resource.resourceDataKey ? [resource.resourceDataKey] : []),
  );
  for (const resource of previous) {
    if (resource.resourceDataKey && !retainedKeys.has(resource.resourceDataKey)) {
      resource.resourceDataKey.fill(0);
    }
  }
}

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
  next: ActiveAccountSettingsSnapshot | null,
): void {
  const previous = published;
  published = next;
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
  const accepted = previous && belongsToSameAccount(previous, next)
    ? {
        ...next,
        ...(next.savedSecretResources === undefined && previous.savedSecretResources !== undefined
          ? { savedSecretResources: previous.savedSecretResources }
          : {}),
        ...(next.savedSecretCatalogState === undefined && previous.savedSecretCatalogState !== undefined
          ? { savedSecretCatalogState: previous.savedSecretCatalogState }
          : {}),
      }
    : next;
  zeroRetiredSavedSecretResourceDataKeys(previous?.savedSecretResources, accepted.savedSecretResources);
  active = accepted;
  if (!previous || !belongsToSameAccount(previous, accepted)) {
    activeLifetimeToken += 1;
  }
  emitActiveAccountSettingsSnapshot(accepted);
  return { snapshot: accepted, didCommit: true };
}

export function setActiveAccountSettingsSnapshot(next: ActiveAccountSettingsSnapshot): void {
  commitActiveAccountSettingsSnapshot(next);
}

export function getActiveAccountSettingsSnapshot(): ActiveAccountSettingsSnapshot | null {
  return active;
}

/** Pure Account-catalog projection; Settings remains the sole persisted owner. */
export function resolveActiveSavedSecretCatalogCollisionState(
  snapshot: ActiveAccountSettingsSnapshot,
): SavedSecretCatalogCollisionStateV1 {
  return projectSavedSecretCatalogCollisionStateV1(snapshot.settings.secrets);
}

/**
 * Identifies the current process-local Account incumbent.  Consumers that bind
 * authority across async work must capture this token, rather than treating a
 * matching scope key as proof that a retired Account lifetime is current again.
 */
export function getActiveAccountSettingsSnapshotLifetimeToken(): number {
  return activeLifetimeToken;
}

/** Publishes a resource-catalog refresh without pretending Settings advanced. */
export function commitActiveSavedSecretCatalog(input: Readonly<{
  scopeKey: string;
  lifetimeToken: number;
  resources: readonly SavedSecretCatalogResourceInputV1[];
  state: SavedSecretCatalogState;
}>): boolean {
  const previous = active;
  if (!previous || previous.scopeKey !== input.scopeKey || activeLifetimeToken !== input.lifetimeToken) return false;
  zeroRetiredSavedSecretResourceDataKeys(previous.savedSecretResources, input.resources);
  const next: ActiveAccountSettingsSnapshot = {
    ...previous,
    savedSecretResources: input.resources,
    savedSecretCatalogState: input.state,
  };
  active = next;
  publishSavedSecretCatalogIfChanged(next);
  return true;
}

function withdrawSavedSecretCatalogMaterial(input: Readonly<{
  scopeKey: string;
  lifetimeToken: number;
}>): ActiveAccountSettingsSnapshot | null {
  const previous = active;
  if (!previous || previous.scopeKey !== input.scopeKey || activeLifetimeToken !== input.lifetimeToken) return null;
  const resources = (previous.savedSecretResources ?? []).map(({ resourceDataKey, ...resource }) => {
    resourceDataKey?.fill(0);
    return { ...resource, storedContent: null };
  });
  const next: ActiveAccountSettingsSnapshot = {
    ...previous,
    savedSecretResources: resources,
    savedSecretCatalogState: 'temporarily_unavailable',
  };
  active = next;
  return next;
}

/**
 * The listener-visible content of a catalog publication. Opened resource DEKs
 * are derived from the row's envelope and change only with its stored content,
 * so only their presence is part of the logical catalog.
 */
function savedSecretCatalogPublicationKey(snapshot: ActiveAccountSettingsSnapshot): string {
  return JSON.stringify([
    snapshot.savedSecretCatalogState ?? null,
    (snapshot.savedSecretResources ?? []).map(({ resourceDataKey, ...resource }) => [
      resource,
      resourceDataKey !== undefined,
    ]),
  ]);
}

/**
 * A catalog refresh re-observes the Home on every AccountChange wake and every
 * operation admission. Listeners restart Sessions and prepare direct material,
 * so they are woken only when the authorized catalog actually changed
 * (teams-lane-10 08 §5.8; 06 L10D-R13).
 */
function publishSavedSecretCatalogIfChanged(next: ActiveAccountSettingsSnapshot): void {
  if (
    published
    && published.scopeKey === next.scopeKey
    && published.settings === next.settings
    && savedSecretCatalogPublicationKey(published) === savedSecretCatalogPublicationKey(next)
  ) {
    // Consumers already hold this logical snapshot; adopt the current object so
    // a later unchanged re-publication keeps its identity.
    published = next;
    return;
  }
  emitActiveAccountSettingsSnapshot(next);
}

/**
 * Starts a catalog refresh: a refresh is an authorization observation boundary,
 * so opened material is retired before waiting on the Home and synchronous
 * readers fail closed meanwhile. Nothing is published here; the refresh
 * publishes its outcome once, through `commitActiveSavedSecretCatalog` or
 * `withdrawActiveSavedSecretCatalog`, and only if it differs from what
 * listeners last observed.
 */
export function beginActiveSavedSecretCatalogRefresh(input: Readonly<{
  scopeKey: string;
  lifetimeToken: number;
}>): boolean {
  return withdrawSavedSecretCatalogMaterial(input) !== null;
}

/**
 * Fails shared material closed when the Home can no longer be observed while
 * retaining only repairable metadata for retry UX.
 */
export function withdrawActiveSavedSecretCatalog(input: Readonly<{
  scopeKey: string;
  lifetimeToken: number;
}>): boolean {
  const next = withdrawSavedSecretCatalogMaterial(input);
  if (!next) return false;
  publishSavedSecretCatalogIfChanged(next);
  return true;
}

/** Retires all shared material and metadata when the Teams master feature is disabled. */
export function disableActiveSavedSecretCatalog(input: Readonly<{
  scopeKey: string;
  lifetimeToken: number;
}>): boolean {
  return commitActiveSavedSecretCatalog({
    ...input,
    resources: Object.freeze([]),
    state: 'disabled',
  });
}

/**
 * Revokes the current process-local Account Settings incumbent at logout.
 * Subscribers observe this transition so custody bound to the prior Account
 * cannot become current again if that Account is later selected anew.
 */
export function clearActiveAccountSettingsSnapshot(): void {
  const previous = active;
  if (!previous) return;
  zeroRetiredSavedSecretResourceDataKeys(previous.savedSecretResources, undefined);
  active = null;
  activeLifetimeToken += 1;
  emitActiveAccountSettingsSnapshot(null);
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

/**
 * The configured External Session source revision. It extends the Account
 * Settings revision with the active Account lifetime and Connected Services
 * projection so source materializers use their existing revision lifecycle
 * when either input changes.
 */
export function resolveActiveAccountConfiguredExternalSessionSourceRevision(
  snapshot: ActiveAccountSettingsSnapshot | null,
): string {
  return [
    resolveActiveAccountSettingsSnapshotRevision(snapshot),
    'connected-services',
    activeLifetimeToken,
    activeConnectedServicesProjectionRevision,
  ].join(':');
}

/**
 * Publishes a Connected Services projection change through the existing active
 * Account snapshot cut. A notification for a non-active Account cannot retire
 * the active Account's configured sources.
 */
export function notifyActiveAccountConnectedServicesProjection(scopeKey: string): void {
  const snapshot = active;
  if (snapshot?.scopeKey && snapshot.scopeKey !== scopeKey) return;
  activeConnectedServicesProjectionRevision += 1;
  emitActiveAccountSettingsSnapshot(snapshot);
}

export function resetActiveAccountSettingsSnapshotForTests(): void {
  const previous = active;
  zeroRetiredSavedSecretResourceDataKeys(previous?.savedSecretResources, undefined);
  active = null;
  published = null;
  if (previous) activeLifetimeToken += 1;
  activeConnectedServicesProjectionRevision = 0;
}

export function subscribeActiveAccountSettingsSnapshot(listener: ActiveAccountSettingsSnapshotListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Subscribes to publications that change the snapshot itself: Settings, the
 * Saved Secret catalog, or the Account lifetime. A Connected Services
 * projection re-publication of the unchanged snapshot is excluded; its one
 * producer pairs it with the consumers' own projection invalidation.
 */
export function subscribeActiveAccountSettingsSnapshotChanges(
  listener: ActiveAccountSettingsSnapshotListener,
): () => void {
  return subscribeActiveAccountSettingsSnapshot((previous, next) => {
    if (previous === next) return;
    listener(previous, next);
  });
}
