import type { JsonValue, PluginCancellationOptions } from '@happier-dev/plugin-sdk';
import type { PluginUiEphemeralSharedScope } from '@happier-dev/plugin-ui';

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
 * The host owns the Account + plugin + immutable-generation lifetime and offers
 * that exact scope to every artifact of the generation. Triage stores its one
 * existing list-window store beneath one versioned plugin-local key. The shell
 * and Composer picker therefore share rows, continuations, pacing and
 * single-flight even though their JavaScript modules are separate realms.
 *
 * The scope is intentionally opaque: Triage receives no Account id and cannot
 * accidentally key one Account's rows into another's. There is no `globalThis`
 * fallback, durable corpus, second cache, or second scheduler. A renderer that
 * cannot provide the host scope stays cold at that real platform boundary.
 */

/**
 * What the window needs from a mounted surface: the ability to invoke this
 * plugin's own aggregate list Action. It is deliberately not the whole Host API
 * — nothing else about a mount takes part in assembling the window. Its object
 * identity addresses only this artifact's registration; the separate
 * host-owned scope supplies Account/plugin/generation identity.
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
  readonly shared: SharedMountedWindow;
  readonly sharedLease: Readonly<{ release(): void }>;
  readonly unregisterClient: () => void;
  /** Live acquisitions in this artifact realm for this exact Host API. */
  leases: number;
};

const mountedByHost = new Map<
  TriageListWindowHostV1,
  Map<PluginUiEphemeralSharedScope, MountedWindow>
>();
const TRIAGE_LIST_WINDOW_SHARED_KEY_V1 = 'triage.list-window.v1';

type SharedMountedWindow = Readonly<{
  store: TriageListWindowStoreV1;
  registerClient(host: TriageListWindowHostV1): () => void;
}>;

function mountedFor(
  host: TriageListWindowHostV1,
  scope: PluginUiEphemeralSharedScope | null,
): MountedWindow | undefined {
  const byScope = mountedByHost.get(host);
  if (scope === null || byScope === undefined) return undefined;
  return byScope.get(scope);
}

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
 * Acquire the generation's mounted window from one surface artifact.
 *
 * The scope's first live acquisition creates its store; later acquisitions in
 * this or another artifact join it. The caller cannot supply a value or reach
 * another scope's. A missing/refused host scope yields an inert lease and no
 * local substitute.
 */
export function acquireTriageListWindow(
  host: TriageListWindowHostV1,
  scope: PluginUiEphemeralSharedScope | null,
): TriageListWindowLeaseV1 {
  if (scope === null) return Object.freeze({ release() {} });
  const byScope = mountedByHost.get(host);
  const existing = byScope?.get(scope);

  let mounted = existing;
  if (mounted === undefined) {
    const sharedLease = scope?.acquire<SharedMountedWindow>(
      TRIAGE_LIST_WINDOW_SHARED_KEY_V1,
      () => {
        const clients = new Map<TriageListWindowHostV1, number>();
        const store = createTriageListWindowStore({
          readEntries: async (input, options) => {
            const client = clients.keys().next().value as TriageListWindowHostV1 | undefined;
            if (client === undefined) throw new Error('No live Triage list-window client is mounted.');
            try {
              return await readEntriesThrough(client, input, options);
            } catch (error) {
              // This is a safe aggregate read, not an outward mutation. If the
              // artifact carrying it retired while the Action was in flight,
              // finish the shared pass through one still-live artifact. An
              // error from a client that remains registered is authoritative
              // and is never blindly retried.
              if (clients.has(client) || options?.signal?.aborted === true) throw error;
              const replacement = clients.keys().next().value as TriageListWindowHostV1 | undefined;
              if (replacement === undefined) throw error;
              return await readEntriesThrough(replacement, input, options);
            }
          },
          nowMs: () => Date.now(),
        });
        const value: SharedMountedWindow = Object.freeze({
          store,
          registerClient(client) {
            clients.set(client, (clients.get(client) ?? 0) + 1);
            let registered = true;
            return () => {
              if (!registered) return;
              registered = false;
              const remaining = (clients.get(client) ?? 1) - 1;
              if (remaining > 0) clients.set(client, remaining);
              else clients.delete(client);
            };
          },
        });
        return Object.freeze({
          value,
          dispose() {
            clients.clear();
            store.dispose();
          },
        });
      },
    );
    if (sharedLease === null || sharedLease === undefined) {
      return Object.freeze({ release() {} });
    }
    mounted = {
      shared: sharedLease.value,
      sharedLease,
      unregisterClient: sharedLease.value.registerClient(host),
      leases: 0,
    };
  }
  mounted.leases += 1;
  if (existing === undefined) {
    const target = byScope ?? new Map<PluginUiEphemeralSharedScope, MountedWindow>();
    target.set(scope, mounted);
    if (byScope === undefined) mountedByHost.set(host, target);
  }

  let released = false;
  return Object.freeze({
    release() {
      if (released) return;
      released = true;
      mounted.leases -= 1;
      if (mounted.leases > 0) return;
      const currentByScope = mountedByHost.get(host);
      if (currentByScope?.get(scope) === mounted) currentByScope.delete(scope);
      if (currentByScope?.size === 0) mountedByHost.delete(host);
      mounted.unregisterClient();
      mounted.sharedLease.release();
    },
  });
}

/** Observe the shared window through this artifact's lease. */
export function subscribeToTriageListWindow(
  host: TriageListWindowHostV1,
  listener: () => void,
  scope: PluginUiEphemeralSharedScope | null,
): () => void {
  const store = mountedFor(host, scope)?.shared.store;
  if (store === undefined) return () => {};
  return store.subscribe(listener);
}

export function readTriageListWindowSnapshot(
  host: TriageListWindowHostV1,
  scope: PluginUiEphemeralSharedScope | null,
): TriageListWindowSnapshotV1 {
  return mountedFor(host, scope)?.shared.store.getSnapshot() ?? UNMOUNTED_SNAPSHOT;
}

/**
 * The only path from a surface to provider work. Pacing, single-flight and
 * last-known-good retention all stay with the store and its coordinator.
 *
 * Naming a host addresses this artifact's lease; the one shared store chooses
 * a currently registered mount client when a pass actually crosses the Action
 * boundary.
 */
export function refreshTriageListWindow(
  trigger: TriageRefreshTriggerV1,
  host: TriageListWindowHostV1,
  scope: PluginUiEphemeralSharedScope | null,
): Promise<void> {
  return mountedFor(host, scope)?.shared.store.refresh(trigger) ?? Promise.resolve();
}

/**
 * Append one more bounded window to the shared mount, or retry the append that
 * failed. Both artifacts consequently observe the same continuation depth.
 */
export function loadMoreTriageListWindow(
  host: TriageListWindowHostV1,
  scope: PluginUiEphemeralSharedScope | null,
): Promise<void> {
  return mountedFor(host, scope)?.shared.store.loadMore() ?? Promise.resolve();
}

export function setTriageListWindowLens(
  lens: TriageListLensV1,
  host: TriageListWindowHostV1,
  scope: PluginUiEphemeralSharedScope | null,
): void {
  mountedFor(host, scope)?.shared.store.setLens(lens);
}
