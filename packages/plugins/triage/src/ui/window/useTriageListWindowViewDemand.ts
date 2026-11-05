import { useEffect, useRef } from 'react';
import { TRIAGE_DATA_ACTION_EXECUTION_V1 } from '../../accountExecution.js';
import { usePluginHostReadiness, type PluginUiHostReadiness } from '@happier-dev/plugin-ui';

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
  readClientReadiness: PluginUiHostReadiness | undefined,
  readOwner: object | null,
): void {
  const ownReadiness = usePluginHostReadiness(Object.is(TRIAGE_DATA_ACTION_EXECUTION_V1.target, 'daemon'));
  const readiness = readClientReadiness ?? ownReadiness;
  const machineReadiness = usePluginHostReadiness();
  const previous = useRef<Readonly<{
    active: boolean;
    readOwner: object | null;
    readiness: PluginUiHostReadiness;
    machineReadiness: PluginUiHostReadiness;
  }> | null>(null);

  useEffect(() => {
    // A replacement facade has no owner until its subscription acquires the
    // shared window. Absence is not a new owner/admission observation.
    if (readOwner === null) return;
    const preceding = previous.current;
    previous.current = Object.freeze({ active, readOwner, readiness, machineReadiness });

    // Host facades/callbacks may change without replacing the shared window.
    // Only its actual owner, activity, or admission facts produce new demand.
    const mountOrScopeChanged = preceding === null || preceding.readOwner !== readOwner;
    const regainedActivity = preceding !== null && !preceding.active && active;
    const reacquire = preceding !== null && (
      readiness.revision > preceding.readiness.revision
      || preceding.readiness.pending || preceding.readiness.ready === false
    );
    const machineBecameAvailable = preceding !== null && !machineReadiness.pending && machineReadiness.ready !== false && (
      machineReadiness.revision > preceding.machineReadiness.revision
      || preceding.machineReadiness.pending || preceding.machineReadiness.ready === false
    );
    // A retained inactive surface must stay demand-silent. The host's active
    // fact gates both view demand and the shared owner's re-acquisition.
    // Readiness is supplied by the host, independently from public activity.
    // Hand the declared read's readiness edge to the same window/coalescing owner.
    // Machine readiness only refreshes deferred sources; it never gates Account demand.
    if (!active || readiness.pending || readiness.ready === false || (!mountOrScopeChanged && !regainedActivity && !reacquire && !machineBecameAvailable)) return;

    void refresh(reacquire || machineBecameAvailable ? 'manual' : 'view');
  }, [active, refresh, readOwner, readiness, machineReadiness]);
}
