import type { JsonValue, PluginCancellationOptions } from '@happier-dev/plugin-sdk';

import {
  TRIAGE_LIST_ENTRIES_ACTION_LOCAL_ID_V1,
  TriageListEntriesResultV1Schema,
  type TriageListEntriesInputV1,
  type TriageListEntriesResultV1,
} from '../../actions/listEntriesProtocol.js';
import type { TriageListLensV1 } from '../../projection/listWindow.js';
import {
  createTriageListWindowStore,
  type TriageListWindowSnapshotV1,
  type TriageListWindowStoreV1,
} from '../../projection/listWindowStore.js';
import type { TriageRefreshTriggerV1 } from '../../refresh/refreshEligibility.js';

/**
 * The acquisition seam for the mounted PRs & Issues window.
 *
 * A surface reads rows by invoking this plugin's own aggregate list Action
 * through the Host API object its mount was given. That object is the scope:
 * the host builds exactly one per mount and rebuilds it whenever the mount's
 * Account lifetime changes, so two surfaces hold the same object only when they
 * are the same mount of the same Account under the same generation. The plugin
 * therefore never needs — and is never given — an Account id to tell two scopes
 * apart, which is the only way an id-free author can key anything at all.
 *
 * That is why the window is per host object rather than per module. A single
 * module-global window would be wrong in both directions:
 *
 * - it would let a surface mounted for one Account join a window another
 *   Account's surface built, and dispatch its own reads through that other
 *   mount's Host API — a disclosure, not a caching artifact;
 * - it would let a retired mount's in-flight pass keep publishing into the
 *   window a live mount is reading, because the retiring lease was not the one
 *   holding the store alive.
 *
 * Within one scope the single-window property is unchanged and still structural:
 * a consumer acquires by naming only its own host and receives a lease whose
 * sole capability is releasing itself; reading, refreshing and re-lensing are
 * module functions over the window *of a named host*, so there is no store
 * handle to hold, pass, replace or dispose; the store is created on that scope's
 * first live acquisition and disposed on its last release.
 *
 * Across UI artifacts there is nothing to coordinate here at all. The shell page
 * and the Composer picker are separate artifacts, and the host's module registry
 * keys a loaded module by contribution, so each already runs its own realm with
 * its own copy of this module. Parking the window on a cross-realm global to
 * reunite them would replace an Account-scoped lifetime with one that outlives
 * every Account — the exact disclosure above, in exchange for a saved pass.
 */

/**
 * What the window needs from a mounted surface: the ability to invoke this
 * plugin's own aggregate list Action. It is deliberately not the whole Host API
 * — nothing else about a mount takes part in assembling the window — but it is
 * the same object identity the host stamps per mount and Account lifetime, so
 * it doubles as this seam's scope key.
 */
export type TriageListWindowHostV1 = Readonly<{
  executeAction(
    action: string,
    input: JsonValue,
    options?: PluginCancellationOptions,
  ): Promise<unknown>;
}>;

/** A live acquisition. Releasing is the only thing a consumer may do to it. */
export type TriageListWindowLeaseV1 = Readonly<{ release(): void }>;

type MountedWindow = {
  readonly store: TriageListWindowStoreV1;
  /** Live acquisitions of this one scope; the store outlives none of them. */
  leases: number;
};

const mountedByHost = new Map<TriageListWindowHostV1, MountedWindow>();

/**
 * What a consumer reads before its surface has acquired the window. It is a
 * frozen constant rather than a fresh object because an external-store reader
 * that returned a new value on every read would re-render forever.
 */
const UNMOUNTED_SNAPSHOT: TriageListWindowSnapshotV1 = Object.freeze({
  freshness: 'unknown',
  pending: 'idle',
  configuredSources: Object.freeze([]),
});

async function readEntriesThrough(
  host: TriageListWindowHostV1,
  input: TriageListEntriesInputV1,
  options?: PluginCancellationOptions,
): Promise<TriageListEntriesResultV1> {
  const result = await host.executeAction(
    TRIAGE_LIST_ENTRIES_ACTION_LOCAL_ID_V1,
    input,
    options,
  );
  // The Action crosses a JSON transport, so its own published result schema —
  // not a cast — is what admits the value the window is assembled from.
  return TriageListEntriesResultV1Schema.parse(result);
}

/**
 * Acquire the window of one mounted surface.
 *
 * The scope's first live acquisition creates its store; a later acquisition of
 * the same host joins it. The caller cannot influence which window it gets,
 * cannot supply one, and cannot reach another scope's.
 */
export function acquireTriageListWindow(host: TriageListWindowHostV1): TriageListWindowLeaseV1 {
  const existing = mountedByHost.get(host);
  const mounted: MountedWindow = existing ?? {
    store: createTriageListWindowStore({
      readEntries: (input, options) => readEntriesThrough(host, input, options),
      nowMs: () => Date.now(),
    }),
    leases: 0,
  };
  mounted.leases += 1;
  if (existing === undefined) mountedByHost.set(host, mounted);

  let released = false;
  return Object.freeze({
    release() {
      if (released) return;
      released = true;
      mounted.leases -= 1;
      if (mounted.leases > 0) return;
      // Only this scope retires; another Account's mount keeps its own window.
      if (mountedByHost.get(host) === mounted) mountedByHost.delete(host);
      mounted.store.dispose();
    },
  });
}

/** Observe one surface's window. Listening does not keep it alive; a lease does. */
export function subscribeToTriageListWindow(
  host: TriageListWindowHostV1,
  listener: () => void,
): () => void {
  const store = mountedByHost.get(host)?.store;
  if (store === undefined) return () => {};
  return store.subscribe(listener);
}

export function readTriageListWindowSnapshot(
  host: TriageListWindowHostV1,
): TriageListWindowSnapshotV1 {
  return mountedByHost.get(host)?.store.getSnapshot() ?? UNMOUNTED_SNAPSHOT;
}

/**
 * The only path from a surface to provider work. Pacing, single-flight and
 * last-known-good retention all stay with the store and its coordinator.
 *
 * Naming a host addresses that surface's window. Every demand must name its
 * exact scope: there is no "current" scope to guess at, and reading through
 * another mount's Host API is the very thing this seam exists to prevent.
 */
export function refreshTriageListWindow(
  trigger: TriageRefreshTriggerV1,
  host: TriageListWindowHostV1,
): Promise<void> {
  return mountedByHost.get(host)?.store.refresh(trigger) ?? Promise.resolve();
}

/**
 * Append one more bounded window to a named surface's mount, or retry the
 * append that failed.
 *
 * It names a host because the read leaves through that mount's own Host API.
 * Depth is what one reader asked *this* surface for by pressing its own
 * continuation row; deepening every mounted window because one of them was
 * pressed would make another surface pay for a page nobody asked it for.
 */
export function loadMoreTriageListWindow(
  host: TriageListWindowHostV1,
): Promise<void> {
  return mountedByHost.get(host)?.store.loadMore() ?? Promise.resolve();
}

export function setTriageListWindowLens(
  lens: TriageListLensV1,
  host: TriageListWindowHostV1,
): void {
  mountedByHost.get(host)?.store.setLens(lens);
}
