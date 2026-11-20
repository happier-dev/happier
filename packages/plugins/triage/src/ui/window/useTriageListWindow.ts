import { useCallback, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { TRIAGE_DATA_ACTION_EXECUTION_V1 } from '../../accountExecution.js';
import { usePluginHostApi, usePluginHostReadiness, usePluginSurfaceActivity, usePluginUiEphemeralSharedScope, usePluginUiDataClientOrNull, type PluginUiHostReadiness } from '@happier-dev/plugin-ui';

import type { TriageListLensV1 } from '../../projection/listWindow.js';
import type { TriageListWindowSnapshotV1, TriageListWindowStoreV1 } from '../../projection/listWindowStore.js';
import type { TriageListPublicationV1 } from '../list/publication.js';
import type { TriageRefreshTriggerV1 } from '../../refresh/refreshEligibility.js';
import {
  acquireTriageListWindow,
  loadMoreTriageListWindow,
  readTriageMountedWindowReadState,
  readTriageListWindowReadOwner,
  setTriageListWindowReadiness,
  refreshTriageListWindow,
  setTriageListWindowLens,
  subscribeToTriageListWindow,
} from './mountedWindow.js';

/**
 * Read this surface's mounted PRs & Issues window.
 *
 * Acquisition rides on the external-store subscription rather than on a render
 * or a separate effect, because React already owns that lifecycle: it
 * subscribes when the consumer commits and unsubscribes when it unmounts, so a
 * render that never commits cannot leak an acquisition and a StrictMode replay
 * cannot double-count one. It is also what makes a host scope change safe:
 * React resubscribes, releases this artifact's old shared-value lease, and
 * joins the new Account/plugin/generation scope without inheriting rows.
 * A hidden surface holds the retained snapshot without registering a live client.
 *
 * Reading is not demanding. Mounting *the PRs & Issues page* is a named
 * materialization producer (`core/CORPUS.md` §4.1) and mounting the Composer
 * picker is not, so the demand belongs to the page rather than to this shared
 * hook: opening the picker must not turn a cold shared window into a full walk
 * of every configured source. A consumer that is a producer calls `refresh` from
 * its own mount effect; every demand it makes passes through the shared window
 * scheduler, which coalesces bursts and respects the source's retry deadline.
 *
 * There is no timer and no poller here, and none anywhere beneath it.
 */
export type TriageMountedListWindowV1 = Readonly<{
  /** Existing Account/plugin/generation-shared window identity. */
  readOwner: TriageListWindowStoreV1 | null;
  /** Includes completedAtMs from the freshness owner for the shell's read-age display. */
  snapshot: TriageListWindowSnapshotV1;
  readiness: PluginUiHostReadiness;
  /** Explicit user demand; the shell's **Refresh** control passes `manual`. */
  refresh(trigger: TriageRefreshTriggerV1): Promise<void>;
  /**
   * Explicit user demand for the entries after this mount's last window — the
   * reader pressed a section's continuation row. What pressing it would do is
   * published as `snapshot.loadMore`, so a surface never has to guess whether
   * the press it is offering would do anything.
   */
  loadMore(): Promise<void>;
  /** Order/query/filter changes rebuild this window from its retained rows. */
  setLens(lens: TriageListLensV1): void;
}>;

export function useTriageListWindow(publication?: TriageListPublicationV1): TriageMountedListWindowV1 {
  const hostApi = usePluginHostApi();
  const dataClient = usePluginUiDataClientOrNull();
  const { active } = usePluginSurfaceActivity();
  const sharedScope = usePluginUiEphemeralSharedScope();
  const hostReadiness = usePluginHostReadiness(Object.is(TRIAGE_DATA_ACTION_EXECUTION_V1.target, 'daemon'));
  const committedReadiness = useRef(hostReadiness);
  useLayoutEffect(() => {
    committedReadiness.current = hostReadiness;
    setTriageListWindowReadiness(hostApi, sharedScope, hostReadiness);
  }, [hostApi, sharedScope, hostReadiness]);

  const subscribe = useCallback((listener: () => void) => {
    const lease = acquireTriageListWindow(hostApi, sharedScope, committedReadiness.current, dataClient, active);
    const unsubscribe = active ? subscribeToTriageListWindow(hostApi, change => {
      publication?.synchronize(readTriageMountedWindowReadState(hostApi, sharedScope).snapshot, change);
      listener();
    }, sharedScope) : undefined;
    return () => {
      unsubscribe?.();
      lease.release();
    };
  }, [hostApi, sharedScope, publication, dataClient, active]);

  // Host identity addresses this artifact's local lease; Account/plugin/install
  // isolation and retirement belong to the injected shared scope.
  const readSnapshot = useCallback(
    () => readTriageMountedWindowReadState(hostApi, sharedScope),
    [hostApi, sharedScope],
  );
  const readShape = useCallback(() => {
    const state = readSnapshot();
    if (publication === undefined) return state;
    publication.synchronize(state.snapshot);
    return `${publication.getRevision()}:${state.readiness?.revision}:${state.readiness?.pending}:${state.readiness?.ready}`;
  }, [readSnapshot, publication]);
  // The shell subscribes to structure, but always reads the owner's full current snapshot.
  // Ordinary consumers retain the full-snapshot subscription.
  useSyncExternalStore(subscribe, readShape, readShape);
  const { snapshot: acquired, readiness: readClientReadiness } = readSnapshot();
  const readOwner = readTriageListWindowReadOwner(hostApi, sharedScope);
  // Before subscription commits there is no transport client. Use this mount's
  // shared host fact rather than inventing an admitted initial observation.
  const readiness = readClientReadiness ?? hostReadiness;
  const refresh = useCallback(
    (trigger: TriageRefreshTriggerV1) => readiness.pending || readiness.ready === false
      ? Promise.resolve() : refreshTriageListWindow(trigger, hostApi, sharedScope),
    [hostApi, sharedScope, readiness.pending, readiness.ready],
  );
  const loadMore = useCallback(
    () => readiness.pending || readiness.ready === false
      ? Promise.resolve() : loadMoreTriageListWindow(hostApi, sharedScope),
    [hostApi, sharedScope, readiness.pending, readiness.ready],
  );
  const setLens = useCallback(
    (lens: TriageListLensV1) => { setTriageListWindowLens(lens, hostApi, sharedScope); },
    [hostApi, sharedScope],
  );

  const snapshot = useMemo<TriageListWindowSnapshotV1>(() => {
    if (readiness.pending) {
      const { error: _error, unreadableSources: _unreadableSources, ...retained } = acquired;
      return Object.freeze({ ...retained, pending: acquired.window === undefined ? 'initial' : 'refresh' });
    }
    // No read can start after settled admission refusal. Project that fact into
    // the existing unavailable presentation, without inventing a completed
    // empty window or replacing retained rows, a real pending read or its error.
    if (readiness.ready === false && acquired.pending === 'idle'
      && acquired.window === undefined && acquired.error === undefined) {
      return Object.freeze({ ...acquired, error: Object.freeze({ code: 'unavailable', message: 'unavailable' }) });
    }
    return acquired;
  }, [acquired, readiness.pending, readiness.ready]);

  return useMemo(() => Object.freeze({
    readOwner,
    snapshot,
    readiness,
    refresh,
    loadMore,
    setLens,
  }), [readOwner, snapshot, readiness, refresh, loadMore, setLens]);
}
