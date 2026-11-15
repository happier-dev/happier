import * as React from 'react';
import type { MachineManagedServicesSummaryV1 } from '@happier-dev/protocol/machines/machinePublishedContentV1';

import { readMachineUpdateFacts } from '@/components/machines/updates/machineFleetUpdates';
import type { MachineUpdatesPageEntry } from '@/components/machines/security/useMachineUpdatesPage';
import { useMachineField } from '@/sync/store/hooks';

import { useMachinePageOnline } from './useMachinePageTarget';

export type MachinePageTabCount = Readonly<{
  count: string;
  countTone?: 'danger' | 'warning';
}>;

const NO_COUNTS: ReadonlyMap<string, MachinePageTabCount> = new Map();

/**
 * What the Machine page's tabs count (lab mOv "Services 9", "Security • 3"), from facts the Machine publishes: its
 * services quietly, or how many fail as the needs-you count; its waiting security updates as needing the person. An
 * offline Machine's last answer is not today's, and nothing reported counts nothing.
 */
export function machinePageTabCounts(
  input: Readonly<{
    online: boolean | null;
    managedServices: MachineManagedServicesSummaryV1 | null;
    updates: MachineUpdatesPageEntry['observation'];
  }>,
): ReadonlyMap<string, MachinePageTabCount> {
  if (input.online !== true) return NO_COUNTS;
  const counts = new Map<string, MachinePageTabCount>();
  const services = input.managedServices;
  if (services && services.failing > 0)
    counts.set('services', {
      count: String(services.failing),
      countTone: 'danger',
    });
  else if (services && services.running > 0)
    counts.set('services', { count: String(services.running) });
  const security = readMachineUpdateFacts(input.updates).security ?? 0;
  if (security > 0)
    counts.set('security', { count: String(security), countTone: 'warning' });
  return counts;
}

/** The page's tab counts, read from the two published fields they come from. */
export function useMachinePageTabCounts(
  serverId: string,
  machineId: string,
): ReadonlyMap<string, MachinePageTabCount> {
  const online = useMachinePageOnline(serverId, machineId);
  const enabled = online === true && machineId.length > 0;
  const managedServices = useMachineField(
    machineId,
    'daemonState',
    'managedServices',
    { enabled, serverId },
  );
  const setup = useMachineField(machineId, 'daemonState', 'setup', {
    enabled,
    serverId,
  });
  const updates = setup?.updates ?? null;
  return React.useMemo(
    () =>
      machinePageTabCounts({
        online,
        managedServices: managedServices ?? null,
        updates,
      }),
    [managedServices, online, updates],
  );
}
