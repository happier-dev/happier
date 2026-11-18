import * as React from 'react';

import { isMachineOnline } from '@/sync/domains/machines/reachability/machinePresence';
import { retainKeyedRows } from '@/sync/domains/state/structuralSharing';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { selectMachineCollectionMembership } from '@/components/settings/machines/collection/machineCollectionModel';
import { useManagedMachineInventory } from '@/components/settings/machines/managed/useManagedMachineInventory';
import { selectMachineFleet } from '@/sync/domains/machines/identity/filterVisibleMachines';
import { useMachineListForServerSelection } from '@/sync/store/hooks';
import { resolveMachineDisplayNames } from '@/utils/sessions/machineDisplayNames';

import { useMachineUpdatesPage } from '../security/useMachineUpdatesPage';
import {
  orderFleetUpdatesRows,
  readFleetUpdatesRow,
  summarizeFleetUpdates,
  type FleetMachine,
  type FleetUpdatesRow,
  type FleetUpdatesSummary,
} from './machineFleetUpdates';

const identity = (machines: readonly Machine[]) => machines;

/**
 * One Home's Machines as the facts the fleet updates show: the Machines collection's members (an ended creation stays
 * in Archive, a sandbox belongs to its host), the same array while none of them changed. Until the managed inventory
 * first answers, the visible enrolled list stands in.
 */
function useFleetMachines(serverId: string): readonly FleetMachine[] {
  const visible = useMachineListForServerSelection(serverId, identity);
  const managedServerIds = React.useMemo(() => [serverId], [serverId]);
  const managed = useManagedMachineInventory(managedServerIds, undefined, undefined, true);
  const managedMachines = managed.firstAnswerPending ? null : managed.machinesByServerId[serverId];
  const previous = React.useRef<readonly FleetMachine[] | null>(null);
  return React.useMemo(() => {
    const members = managedMachines === null
      ? visible
      : selectMachineFleet(selectMachineCollectionMembership(visible, managedMachines).currentEnrolled);
    // The one Machine name owner: a settled name, told apart from its namesakes ("NLDW6-3-11-20 · 2e0f").
    const names = resolveMachineDisplayNames(members);
    previous.current = retainKeyedRows(
      previous.current,
      members.map((machine) => ({
        machineId: machine.id,
        name: names.get(machine.id) ?? machine.id,
        online: isMachineOnline(machine),
        installationId: machine.installationId ?? null,
        platform: machine.metadata?.platform ?? null,
      })),
      (row) => row.machineId,
    );
    return previous.current;
  }, [managedMachines, visible]);
}

/**
 * The fleet's OS updates from the facts each Machine pushes: its Machines, their rows in the order that needs a look
 * first, and the summary. The Updates page and the Machines column's Updates entry read this one owner.
 */
export function useFleetUpdates(serverId: string): Readonly<{
  machines: readonly FleetMachine[];
  rows: readonly FleetUpdatesRow[];
  summary: FleetUpdatesSummary;
}> {
  const machines = useFleetMachines(serverId);
  const machineIds = React.useMemo(
    () => machines.map((machine) => machine.machineId),
    [machines],
  );
  const entries = useMachineUpdatesPage({
    serverId,
    machineIds,
    enabled: machines.length > 0,
  });
  const rows = React.useMemo(
    () =>
      orderFleetUpdatesRows(
        machines.map((machine, index) =>
          readFleetUpdatesRow(machine, entries[index]),
        ),
      ),
    [entries, machines],
  );
  const summary = React.useMemo(() => summarizeFleetUpdates(rows), [rows]);
  return { machines, rows, summary };
}
