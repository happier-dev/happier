import * as React from 'react';
import type { ManagedConfiguredCheckRow } from '@/components/store/inventory/managedOperationalInventory';
import { useMachinePresenceSummaries } from '@/sync/domains/machines/reachability/useMachinePresenceSummary';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { describeMachinePresenceSummary } from '@/utils/sessions/machinePresenceLine';
import { NO_OFFLINE_OBSERVERS } from './serviceCheckPresentation';

/** The Machine presence owner's verdict supplies the stale-check decision on both list and detail. */
export function useServiceCheckOfflineObservers(
  rows: readonly ManagedConfiguredCheckRow[],
  scope: ServerAccountScope | null,
): ReadonlySet<string> {
  const machineIds = React.useMemo(
    () => [...new Set(rows.flatMap((row) =>
      row.native.enabled && row.definitionFacts.kind === 'available' && row.definitionFacts.observerMachineId !== null
        ? [row.definitionFacts.observerMachineId] : []))].sort(),
    [rows],
  );
  const summaries = useMachinePresenceSummaries(scope?.serverId ?? null, machineIds);
  return React.useMemo(() => {
    if (machineIds.length === 0) return NO_OFFLINE_OBSERVERS;
    const offline = machineIds.filter((_, index) => {
      const summary = summaries[index];
      return summary?.machineIsKnown === true && describeMachinePresenceSummary(summary).status === 'offline';
    });
    return offline.length === 0 ? NO_OFFLINE_OBSERVERS : new Set(offline);
  }, [machineIds, summaries]);
}
