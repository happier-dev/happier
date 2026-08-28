import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { usePluginHostApi, usePluginUiEphemeralSharedScope } from '@happier-dev/plugin-ui';

import type { TriageListLensV1 } from '../../projection/listWindow.js';
import type { TriageListWindowSnapshotV1 } from '../../projection/listWindowStore.js';
import type { TriageRefreshTriggerV1 } from '../../refresh/refreshEligibility.js';
import {
  acquireTriageListWindow,
  loadMoreTriageListWindow,
  readTriageListWindowSnapshot,
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
 *
 * Reading is not demanding. Mounting *the PRs & Issues page* is a named
 * materialization producer (`core/CORPUS.md` §4.1) and mounting the Composer
 * picker is not, so the demand belongs to the page rather than to this shared
 * hook: opening the picker must not turn a cold shared window into a full walk
 * of every configured source. A consumer that is a producer calls `refresh` from
 * its own mount effect; every demand it makes still passes through the one
 * shared minimum interval, so a cold or stale window starts exactly one pass no
 * matter how much of that surface asked.
 *
 * There is no timer and no poller here, and none anywhere beneath it.
 */
export type TriageMountedListWindowV1 = Readonly<{
  snapshot: TriageListWindowSnapshotV1;
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

export function useTriageListWindow(): TriageMountedListWindowV1 {
  const hostApi = usePluginHostApi();
  const sharedScope = usePluginUiEphemeralSharedScope();

  const subscribe = useCallback((listener: () => void) => {
    const lease = acquireTriageListWindow(hostApi, sharedScope);
    const unsubscribe = subscribeToTriageListWindow(hostApi, listener, sharedScope);
    return () => {
      unsubscribe();
      lease.release();
    };
  }, [hostApi, sharedScope]);

  // Host identity addresses this artifact's local lease; Account/plugin/install
  // isolation and retirement belong to the injected shared scope.
  const readSnapshot = useCallback(
    () => readTriageListWindowSnapshot(hostApi, sharedScope),
    [hostApi, sharedScope],
  );
  const refresh = useCallback(
    (trigger: TriageRefreshTriggerV1) => refreshTriageListWindow(trigger, hostApi, sharedScope),
    [hostApi, sharedScope],
  );
  const loadMore = useCallback(
    () => loadMoreTriageListWindow(hostApi, sharedScope),
    [hostApi, sharedScope],
  );
  const setLens = useCallback(
    (lens: TriageListLensV1) => { setTriageListWindowLens(lens, hostApi, sharedScope); },
    [hostApi, sharedScope],
  );

  const snapshot = useSyncExternalStore(subscribe, readSnapshot, readSnapshot);

  return useMemo(() => Object.freeze({
    snapshot,
    refresh,
    loadMore,
    setLens,
  }), [snapshot, refresh, loadMore, setLens]);
}
