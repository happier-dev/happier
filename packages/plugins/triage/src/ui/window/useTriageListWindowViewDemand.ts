import { useEffect, useRef } from 'react';

import type { TriageRefreshTriggerV1 } from '../../refresh/refreshEligibility.js';

type RefreshTriageListWindowV1 = (trigger: TriageRefreshTriggerV1) => Promise<void>;

/**
 * Send the named page-view demands to this mount's existing list-window owner.
 *
 * The host is the physical-lifecycle owner and supplies one public `active`
 * fact for its retained plugin surface. This adapter deliberately observes
 * that fact instead of attaching browser/AppState listeners or retaining its
 * own activity history.
 * It owns no pacing, timer, scheduler or provider call — all three live in the
 * mounted list window that receives the resulting `view` demand.
 */
export function useTriageListWindowViewDemand(
  active: boolean,
  refresh: RefreshTriageListWindowV1,
): void {
  const previous = useRef<Readonly<{
    active: boolean;
    refresh: RefreshTriageListWindowV1;
  }> | null>(null);

  useEffect(() => {
    const preceding = previous.current;
    previous.current = Object.freeze({ active, refresh });

    // A new refresh callback is a new host-scoped mounted window. It receives
    // its own initial demand even when the preceding surface was active. For a
    // retained window, only an inactive -> active edge is a new named demand;
    // remaining inactive is intentionally silent.
    const mountOrScopeChanged = preceding === null || preceding.refresh !== refresh;
    const regainedActivity = preceding !== null && !preceding.active && active;
    // A retained inactive surface must stay demand-silent. The host's active
    // fact is the sole gate; the first active mount and each inactive -> active
    // edge are the only named demand producers.
    if (!active || (!mountOrScopeChanged && !regainedActivity)) return;

    void refresh('view');
  }, [active, refresh]);
}
