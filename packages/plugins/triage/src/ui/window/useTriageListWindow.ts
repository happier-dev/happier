import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { usePluginHostApi } from '@happier-dev/plugin-ui';

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
 * cannot double-count one. It is also what makes the scope change safe: the
 * host rebuilds the Host API object when the mount's Account lifetime changes,
 * so React resubscribes, this mount's lease retires the window it was reading,
 * and the new Account starts cold instead of inheriting rows.
 *
 * Reading is not demanding. Mounting *the PRs & Issues page* is a named
 * materialization producer (`core/CORPUS.md` §4.1) and mounting the Composer
 * picker is not, so the demand belongs to the page rather than to this shared
 * hook: the picker runs in its own UI artifact and therefore its own module
 * realm, so a demand here would make every open of the control a full walk of
 * every configured source. A consumer that is a producer calls `refresh` from
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

  const subscribe = useCallback((listener: () => void) => {
    const lease = acquireTriageListWindow(hostApi);
    const unsubscribe = subscribeToTriageListWindow(hostApi, listener);
    return () => {
      unsubscribe();
      lease.release();
    };
  }, [hostApi]);

  // Bound to this mount's own Host API, which is also the window's scope: when
  // the host rebuilds it for a new Account lifetime, React resubscribes, this
  // mount's lease retires its window, and the new scope starts cold.
  const readSnapshot = useCallback(() => readTriageListWindowSnapshot(hostApi), [hostApi]);
  const refresh = useCallback(
    (trigger: TriageRefreshTriggerV1) => refreshTriageListWindow(trigger, hostApi),
    [hostApi],
  );
  const loadMore = useCallback(() => loadMoreTriageListWindow(hostApi), [hostApi]);
  const setLens = useCallback(
    (lens: TriageListLensV1) => { setTriageListWindowLens(lens, hostApi); },
    [hostApi],
  );

  const snapshot = useSyncExternalStore(subscribe, readSnapshot, readSnapshot);

  return useMemo(() => Object.freeze({
    snapshot,
    refresh,
    loadMore,
    setLens,
  }), [snapshot, refresh, loadMore, setLens]);
}
