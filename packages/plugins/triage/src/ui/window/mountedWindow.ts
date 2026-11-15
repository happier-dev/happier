import { CORPUS_SOURCE_INSTANCES_COLLECTION } from '../../corpus/collections/definitions.js';
import { internalTaskLocalRefV1, INTERNAL_TASK_SOURCE_V1 } from '../../internalTasks/identity.js';
import { sameTriageSourceIdentity } from '../../corpus/identity/components.js';
import type { JsonValue, PluginCancellationOptions } from '@happier-dev/plugin-sdk';
import type { PluginUiEphemeralSharedScope, PluginUiHostReadiness, PluginUiDataClient } from '@happier-dev/plugin-ui';

import {
  TRIAGE_LIST_ENTRIES_ACTION_LOCAL_ID_V1,
  TriageListEntriesResultV1Schema,
  type TriageListEntriesInputV1,
  type TriageListEntriesResultV1,
} from '../../actions/listEntriesProtocol.js';
import { reobserveTriagePostMutationRow } from '../detail/postMutationReobservation.js';
import type { TriageListLensV1 } from '../../projection/listWindow.js';
import { TRIAGE_TASKS_LIST_ACTION_LOCAL_ID_V1 } from '../../actions/tasksProtocol.js';
import {
  createTriageListWindowStore,
  type TriageListWindowSnapshotV1,
  type TriageListWindowChangeV1,
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
 * The scope supplies opaque isolation; change notifications carry the receiver
 * Account only to normalize personal versus shared Task addresses. There is no `globalThis`
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

type AccountDataObserver = Pick<PluginUiDataClient, 'watchAccountData'>;

type MountedWindow = {
  readonly shared: SharedMountedWindow;
  readonly sharedLease: Readonly<{ release(): void }>;
  readonly unregisterClient: () => void;
  readState: TriageMountedWindowReadState;
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
  registerClient(host: TriageListWindowHostV1, readiness?: PluginUiHostReadiness, data?: AccountDataObserver | null): () => void;
  // Older v1 artifact producers expose only store/registerClient.
  setClientReadiness?(host: TriageListWindowHostV1, readiness: PluginUiHostReadiness): void;
  readState?(): TriageMountedWindowReadState;
  subscribeReadiness?(listener: () => void): () => void;
}>;

export type TriageMountedWindowReadState = Readonly<{
  snapshot: TriageListWindowSnapshotV1;
  /** No transport client has committed before the first acquisition. */
  readiness: PluginUiHostReadiness | null;
}>;

const UNSPECIFIED_READINESS: PluginUiHostReadiness = Object.freeze({ pending: false, revision: 0 });

function mountedFor(
  host: TriageListWindowHostV1,
  scope: PluginUiEphemeralSharedScope | null,
): MountedWindow | undefined {
  const byScope = mountedByHost.get(host);
  if (scope === null || byScope === undefined) return undefined;
  return byScope.get(scope);
}

function hasOpaqueContinuation(input: TriageListEntriesInputV1): boolean {
  return (input.resume?.length ?? 0) > 0
    || (input.sources.kind === 'allConfigured' && input.sources.cursor !== undefined);
}

/**
 * What a consumer reads before its surface has acquired the window. It is a
 * frozen constant rather than a fresh object because an external-store reader
 * that returned a new value on every read would re-render forever.
 */
const UNMOUNTED_SNAPSHOT: TriageListWindowSnapshotV1 = Object.freeze({
  freshness: 'unknown',
  pending: 'idle',
  passes: 0,
  configuredSources: Object.freeze([]),
});
const UNMOUNTED_READ_STATE: TriageMountedWindowReadState = Object.freeze({
  snapshot: UNMOUNTED_SNAPSHOT, readiness: null,
});

async function readEntriesThrough(
  host: TriageListWindowHostV1,
  input: TriageListEntriesInputV1,
  options?: PluginCancellationOptions,
): Promise<TriageListEntriesResultV1> {
  const result = await host.executeAction(
    input.tasks === undefined ? TRIAGE_LIST_ENTRIES_ACTION_LOCAL_ID_V1 : TRIAGE_TASKS_LIST_ACTION_LOCAL_ID_V1,
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
  readiness: PluginUiHostReadiness = UNSPECIFIED_READINESS,
  data: AccountDataObserver | null = null,
): TriageListWindowLeaseV1 {
  if (scope === null) return Object.freeze({ release() {} });
  const byScope = mountedByHost.get(host);
  const existing = byScope?.get(scope);

  let mounted = existing;
  if (mounted === undefined) {
    const sharedLease = scope?.acquire<SharedMountedWindow>(
      TRIAGE_LIST_WINDOW_SHARED_KEY_V1,
      () => {
        const clients = new Map<TriageListWindowHostV1, { leases: number; readiness: PluginUiHostReadiness | null; data: AccountDataObserver | null }>();
        const readinessListeners = new Set<() => void>();
        let activeReadiness: PluginUiHostReadiness | null = readiness;
        let readState = UNMOUNTED_READ_STATE;
        const publishReadiness = () => {
          // Follow the exact first client the transport below uses. These are
          // shared-owner facts, not another readiness decision. Retiring the
          // final client supplies no new host observation.
          const next = clients.values().next().value;
          if (next === undefined || next.readiness === activeReadiness) return;
          activeReadiness = next.readiness;
          for (const listener of [...readinessListeners]) listener();
        };
        let executionOriginEpoch = 0;
        const store = createTriageListWindowStore({
          readEntries: async (input, options) => {
            const client = clients.keys().next().value as TriageListWindowHostV1 | undefined;
            if (client === undefined) throw new Error('No live Triage list-window client is mounted.');
            const readExecutionOriginEpoch = executionOriginEpoch;
            try {
              const result = await readEntriesThrough(client, input, options);
              if (!clients.has(client)) {
                throw new Error('The Triage list-window client retired before its read settled.');
              }
              return result;
            } catch (error) {
              // This is a safe aggregate read, not an outward mutation. If the
              // artifact carrying it retired while the Action was in flight,
              // finish the shared pass through one still-live artifact. An
              // error from a client that remains registered is authoritative
              // and is never blindly retried.
              if (clients.has(client) || options?.signal?.aborted === true) throw error;
              const replacement = clients.keys().next().value as TriageListWindowHostV1 | undefined;
              if (replacement === undefined) throw error;
              // Provider continuations are opaque to Triage and may be bound
              // to the daemon/materialization that issued them. A same-origin
              // client can finish the read, but a different origin must run
              // the replacement cycle from page one.
              if (
                executionOriginEpoch !== readExecutionOriginEpoch
                && hasOpaqueContinuation(input)
              ) throw error;
              return await readEntriesThrough(replacement, input, options);
            }
          },
          nowMs: () => Date.now(),
        });
        let observedClient: AccountDataObserver | null = null;
        let observation: AbortController | null = null;
        const observeChanges = () => {
          const next = clients.values().next().value?.data ?? null;
          if (next === observedClient) return;
          observation?.abort();
          observation = null;
          observedClient = next;
          if (!next) return;
          const controller = new AbortController();
          observation = controller;
          const selections: Parameters<AccountDataObserver['watchAccountData']>[0][] = [
            { kind: 'internalTasks' },
            { kind: 'collection', collectionId: CORPUS_SOURCE_INSTANCES_COLLECTION.id },
          ];
          for (const selection of selections) void next.watchAccountData(selection, change => {
            if (controller.signal.aborted) return;
            if (selection.kind === 'collection') void store.refresh('view');
            else if (change?.kind === 'internalTasks') {
              const client = clients.keys().next().value;
              if (client === undefined) return;
              const source = store.getSnapshot().configuredSources.find(source => sameTriageSourceIdentity(source.source, INTERNAL_TASK_SOURCE_V1));
              if (source === undefined) return;
              for (const task of change.tasks) {
                const entryRef = { source: INTERNAL_TASK_SOURCE_V1, ...internalTaskLocalRefV1(task.taskId,
                  task.ownerAccountId === change.accountId ? undefined : task.ownerAccountId) };
                void reobserveTriagePostMutationRow(client, { entryRef }, store.getSnapshot().window?.lanes ?? [], source.sourceInstanceId, {
                  signal: controller.signal, sharedScope: scope,
                  publishObservation: observation => store.publishObservation(observation, false, { reconcileMembership: true }),
                }).catch(() => {
                  // Keep the retained row on transport failure; explicit Refresh remains recovery.
                });
              }
            } else void store.refreshSources(store.getSnapshot().configuredSources
              .filter(source => sameTriageSourceIdentity(source.source, INTERNAL_TASK_SOURCE_V1))
              .map(source => source.sourceInstanceId));
          }, { signal: controller.signal }).then(watch => {
            if (controller.signal.aborted) watch.dispose();
            else controller.signal.addEventListener('abort', () => watch.dispose(), { once: true });
          }).catch(() => {
            // Retired/unavailable Data cannot admit a live observation; the
            // incumbent read path remains available for explicit recovery.
          });
        };
        const value: SharedMountedWindow = Object.freeze({
          store,
          readState() {
            const snapshot = store.getSnapshot();
            if (readState.snapshot !== snapshot || readState.readiness !== activeReadiness) {
              readState = Object.freeze({ snapshot, readiness: activeReadiness });
            }
            return readState;
          },
          subscribeReadiness(listener) {
            readinessListeners.add(listener);
            return () => { readinessListeners.delete(listener); };
          },
          setClientReadiness(client, next) {
            const current = clients.get(client);
            if (!current || current.readiness === next) return;
            current.readiness = next;
            publishReadiness();
          },
          registerClient(client, next, data) {
            clients.set(client, { leases: (clients.get(client)?.leases ?? 0) + 1, readiness: next ?? null, data: data ?? null });
            observeChanges();
            publishReadiness();
            let registered = true;
            return () => {
              if (!registered) return;
              registered = false;
              const current = clients.get(client);
              const remaining = (current?.leases ?? 1) - 1;
              if (remaining > 0 && current) current.leases = remaining;
              else clients.delete(client);
              observeChanges();
              publishReadiness();
            };
          },
        });
        return Object.freeze({
          value,
          // Kept by the host while no surface shows it, so Home ↔ page
          // cycling draws the last rows at once and revalidates them. Idle
          // holds no live work: every artifact unregisters its client on release,
          // releasing the shared Data observation, and a read
          // still in flight settles without a client and cannot page further.
          // The host retires the value with its Account or plugin occurrence.
          retainWhenIdle: true,
          onExecutionOriginChange() {
            executionOriginEpoch += 1;
            store.replaceReadTransport();
          },
          dispose() {
            clients.clear();
            observeChanges();
            readinessListeners.clear();
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
      unregisterClient: sharedLease.value.registerClient(host, readiness, data),
      readState: UNMOUNTED_READ_STATE,
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
  listener: (change?: TriageListWindowChangeV1) => void,
  scope: PluginUiEphemeralSharedScope | null,
): () => void {
  const shared = mountedFor(host, scope)?.shared;
  if (shared === undefined) return () => {};
  const unsubscribe = shared.store.subscribe(listener);
  const unsubscribeReadiness = shared.subscribeReadiness?.(listener);
  return () => { unsubscribe(); unsubscribeReadiness?.(); };
}

export function setTriageListWindowReadiness(host: TriageListWindowHostV1,
  scope: PluginUiEphemeralSharedScope | null, readiness: PluginUiHostReadiness): void {
  mountedFor(host, scope)?.shared.setClientReadiness?.(host, readiness);
}

export function readTriageMountedWindowReadState(host: TriageListWindowHostV1,
  scope: PluginUiEphemeralSharedScope | null): TriageMountedWindowReadState {
  const mounted = mountedFor(host, scope);
  if (mounted === undefined) return UNMOUNTED_READ_STATE;
  if (mounted.shared.readState !== undefined) return mounted.shared.readState();
  const snapshot = mounted.shared.store.getSnapshot();
  if (mounted.readState.snapshot !== snapshot) {
    // The original v1 producer owns the same store but has no shared client
    // readiness. Null leaves that fact with the consuming mount's host.
    mounted.readState = Object.freeze({ snapshot, readiness: null });
  }
  return mounted.readState;
}

/** The existing store also identifies windows created by older artifact realms. */
export function readTriageListWindowReadOwner(host: TriageListWindowHostV1,
  scope: PluginUiEphemeralSharedScope | null): TriageListWindowStoreV1 | null {
  return mountedFor(host, scope)?.shared.store ?? null;
}

export function readTriageListWindowSnapshot(
  host: TriageListWindowHostV1,
  scope: PluginUiEphemeralSharedScope | null,
): TriageListWindowSnapshotV1 {
  return mountedFor(host, scope)?.shared.store.getSnapshot() ?? UNMOUNTED_SNAPSHOT;
}

/**
 * Project the retained shared acquisition through a caller lens without
 * changing the shell/picker lens, paging depth, continuations, or subscribers.
 */
export function projectTriageListWindow(
  lens: TriageListLensV1,
  host: TriageListWindowHostV1,
  scope: PluginUiEphemeralSharedScope | null,
): TriageListWindowSnapshotV1['window'] {
  return mountedFor(host, scope)?.shared.store.project(lens);
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
