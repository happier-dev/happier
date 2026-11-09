import { isDeepStrictEqual } from 'node:util';
import { PluginError, type Disposable } from '@happier-dev/plugin-sdk';
import type { SessionSummary, SessionWatchEvent } from '@happier-dev/plugin-sdk/sessions';
import type { AccountEncryptionIdentity } from '@happier-dev/sync-client';

import { fetchChangesAccountId } from '@/api/changes';
import { acquireRequesterAccountEncryptionCurrentness, waitForObservation,
  type RequesterSessionInventoryObservation } from '@/api/client/accountEncryptionCurrentnessObservation';
import { normalizeServerHttpBaseUrl, runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import type { StoredCredentials } from '@/persistence';

export type ObservedPluginSession = Readonly<{ item: SessionSummary; activeAt: number }>;
type InventoryRow = ObservedPluginSession & Readonly<{
  /** A same-clock HTTP projection cannot undo an activity push on this live connection. */
  activity?: Readonly<{ active: boolean; signal: AbortSignal }>;
}>;
type WithoutRevision<T> = T extends unknown ? Omit<T, 'revision'> : never;
type InventoryEvent = WithoutRevision<SessionWatchEvent>;
type Listener = (event: InventoryEvent, isCurrent: () => boolean) => void;
type InventoryInput = Readonly<{
  credentials: StoredCredentials;
  serverBaseUrl: string;
  loadSnapshot(mode: AccountEncryptionIdentity['mode'], signal: AbortSignal): Promise<readonly ObservedPluginSession[]>;
  loadOne(id: string, mode: AccountEncryptionIdentity['mode'], signal: AbortSignal): Promise<ObservedPluginSession | null>;
}>;
type SharedInventory = Readonly<{
  credentials: StoredCredentials;
  subscribe(listener: Listener): Disposable;
  start(): void;
}>;

// A demanded projection, not an authorization cache. The last watcher retires
// its rows and releases the existing shared Account/Home connection and cursor.
const inventories = new Map<string, SharedInventory>();

export function pluginSessionRuntimeAvailability(state: SessionSummary['state']): SessionSummary['runtimeAvailability'] {
  return state === 'active' || state === 'idle'
    ? Object.freeze({ status: 'available' as const })
    : Object.freeze({ status: 'unavailable' as const,
      code: state === 'archived' ? 'session_archived' : 'session_runtime_inactive' });
}

export function observePluginSessionInventory(input: InventoryInput, listener: Listener): Disposable {
  const key = JSON.stringify([normalizeServerHttpBaseUrl(input.serverBaseUrl), input.credentials.token]);
  let inventory = inventories.get(key);
  if (inventory && !isDeepStrictEqual(inventory.credentials.encryption, input.credentials.encryption)) {
    throw new PluginError({ code: 'plugin_sessions_not_authenticated', message: 'Session inventory credentials changed' });
  }
  if (!inventory) {
    inventory = createInventory(input, () => inventories.delete(key));
    inventories.set(key, inventory);
    const subscription = inventory.subscribe(listener);
    inventory.start();
    return subscription;
  }
  return inventory.subscribe(listener);
}

function createInventory(input: InventoryInput, retire: () => void): SharedInventory {
  const listeners = new Set<{ notify: Listener; initialized: boolean }>();
  const rows = new Map<string, InventoryRow>();
  const changedIds = new Set<string>();
  const activityDuringRead = new Map<string, Extract<RequesterSessionInventoryObservation, { kind: 'activity' }>>();
  let observation: ReturnType<typeof acquireRequesterAccountEncryptionCurrentness> | undefined;
  let unsubscribe: (() => void) | undefined;
  let lifetime = new AbortController();
  let identity: AccountEncryptionIdentity | null = null;
  let connected = false;
  let disposed = false;
  let initialized = false;
  let needsSnapshot = true;
  let requested = false;
  let pending: Promise<void> | null = null;

  const invalidate = () => {
    lifetime.abort(); lifetime = new AbortController(); identity = null; needsSnapshot = true;
    activityDuringRead.clear();
    for (const listener of listeners) listener.initialized = false;
  };
  const fence = () => {
    const captured = lifetime;
    const expected = identity;
    return () => !disposed && connected && lifetime === captured && expected !== null
      && (observation?.isCurrent(expected) ?? false);
  };
  const publish = (event: InventoryEvent) => {
    const isCurrent = fence();
    for (const listener of listeners) if (listener.initialized || event.kind === 'resyncRequired') listener.notify(event, isCurrent);
  };
  const publishSnapshots = () => {
    if (!initialized || needsSnapshot || !fence()()) return;
    let items: readonly SessionSummary[] | undefined;
    const isCurrent = fence();
    for (const listener of listeners) if (!listener.initialized) {
      items ??= Object.freeze([...rows.values()].map(row => row.item));
      listener.initialized = true;
      listener.notify({ kind: 'snapshot', items }, isCurrent);
    }
  };
  const withActivity = (row: ObservedPluginSession, activity: Readonly<{ active: boolean; activeAt: number }>): InventoryRow => {
    if (activity.activeAt < row.activeAt) return row;
    const state = row.item.state === 'archived' ? 'archived' : activity.active ? 'active' : 'stopped';
    return { activeAt: activity.activeAt, activity: { active: activity.active, signal: lifetime.signal },
      item: state === row.item.state ? row.item : Object.freeze({ ...row.item, state,
      runtimeAvailability: pluginSessionRuntimeAvailability(state) }) };
  };
  const upsert = (record: InventoryRow) => {
    const previous = rows.get(record.item.id);
    const next = previous?.activity?.signal === lifetime.signal
      && (previous.activeAt > record.activeAt || !record.activity && previous.activeAt === record.activeAt)
      ? withActivity(record, { active: previous.activity.active, activeAt: previous.activeAt }) : record;
    // Compare only the changed producer row. No whole-inventory signatures or watcher diffs.
    const equal = previous !== undefined && isDeepStrictEqual(previous.item, next.item);
    rows.set(next.item.id, equal ? { ...next, item: previous.item } : next);
    if (!equal) publish({ kind: 'upserted', item: next.item });
  };
  const pump = () => {
    if (pending || disposed || !connected || !requested) return;
    const work = (async () => {
      while (requested && !disposed && connected) {
        requested = false;
        const snapshot = needsSnapshot;
        const ids = [...changedIds];
        changedIds.clear();
        if (!snapshot && ids.length === 0) { publishSnapshots(); continue; }
        const captured = lifetime;
        const current = () => !disposed && connected && lifetime === captured;
        try {
          const expected = await observation!.read(captured.signal);
          const nextRows: Array<{ id: string; row: ObservedPluginSession | null }> = await waitForObservation(runWithServerHttpBaseUrl(input.serverBaseUrl, () => snapshot
            ? input.loadSnapshot(expected.mode, captured.signal).then(rows => rows.map(row => ({ id: row.item.id, row })))
            : Promise.all(ids.map(async id => ({ id, row: await input.loadOne(id, expected.mode, captured.signal) })))), captured.signal);
          if (!current()) continue;
          if (!observation!.isCurrent(expected)) throw new Error('Session inventory Account observation retired');
          identity = expected;
          if (snapshot) {
            const present = new Set(nextRows.map(row => row.id));
            // Match the original ordering: changed rows, then removals.
            for (const id of rows.keys()) if (!present.has(id)) nextRows.push({ id, row: null });
          }
          for (const { id, row } of nextRows) {
            if (row) {
              const activity = activityDuringRead.get(id);
              upsert(activity ? withActivity(row, activity) : row);
            } else if (rows.delete(id)) publish({ kind: 'removed', id });
          }
          activityDuringRead.clear();
          initialized = true;
          needsSnapshot = false;
          publishSnapshots();
        } catch {
          if (current()) {
            needsSnapshot = true;
            publish({ kind: 'resyncRequired' });
            // The next real push/reconnect owns recovery; never hot-retry a failed read.
            return;
          }
        }
      }
    })().finally(() => { pending = null; if (requested) pump(); });
    pending = work;
  };
  const receive = (event: RequesterSessionInventoryObservation) => {
    if (disposed) return;
    if (event.kind === 'activity') {
      if (pending || needsSnapshot) activityDuringRead.set(event.id, event);
      const row = rows.get(event.id);
      if (row && fence()()) upsert(withActivity(row, event));
    } else if (event.kind === 'changes') {
      if (event.reset) invalidate();
      for (const id of event.sessionIds) changedIds.add(id);
      requested = true;
      pump();
    } else if (event.kind === 'connected') {
      invalidate(); connected = true; requested = false; changedIds.clear();
      // The existing cursor owner publishes one completed catch-up before the baseline read.
    } else if (event.kind === 'currentness') {
      invalidate(); requested = false; changedIds.clear();
    } else {
      const wasConnected = connected;
      invalidate();
      requested = false;
      changedIds.clear();
      if (event.kind === 'disconnected') {
        connected = false;
        if (wasConnected) publish({ kind: 'resyncRequired' });
      }
      else publish({ kind: 'resyncRequired' });
    }
  };
  return {
    credentials: input.credentials,
    subscribe(notify) {
      const listener = { notify, initialized: false };
      listeners.add(listener);
      publishSnapshots();
      return { dispose() {
        listeners.delete(listener);
        if (listeners.size || disposed) return;
        disposed = true;
        retire();
        lifetime.abort();
        unsubscribe?.();
        void observation?.dispose().catch(() => undefined);
        rows.clear(); changedIds.clear(); activityDuringRead.clear();
      } };
    },
    start() {
      void (async () => {
        const accountId = readAccountIdFromToken(input.credentials.token) ?? await fetchChangesAccountId({
          token: input.credentials.token, serverHttpBaseUrl: input.serverBaseUrl, signal: lifetime.signal,
        });
        if (disposed) return;
        observation = acquireRequesterAccountEncryptionCurrentness({ accountId, token: input.credentials.token,
          serverBaseUrl: input.serverBaseUrl });
        unsubscribe = observation.subscribeSessionInventory(receive);
        const captured = lifetime;
        try {
          await observation.read(captured.signal);
          if (!disposed && lifetime === captured && !connected) publish({ kind: 'resyncRequired' });
        } catch { if (!disposed && lifetime === captured) publish({ kind: 'resyncRequired' }); }
      })().catch(() => { if (!disposed) publish({ kind: 'resyncRequired' }); });
    },
  };
}
