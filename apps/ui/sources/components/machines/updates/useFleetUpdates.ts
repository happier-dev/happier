import * as React from 'react';

import { isMachineOnline } from '@/sync/domains/machines/reachability/machinePresence';
import { retainKeyedRows } from '@/sync/domains/state/structuralSharing';
import type { Machine } from '@/sync/domains/state/storageTypes';
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

/** One Home's Machines as the facts the fleet updates show; the same array while none of them changed. */
function useFleetMachines(serverId: string): readonly FleetMachine[] {
  const select = React.useMemo(() => {
    let previous: readonly FleetMachine[] | null = null;
    return (machines: readonly Machine[]) => {
      // The one Machine name owner: a settled name, told apart from its namesakes ("NLDW6-3-11-20 · 2e0f").
      const names = resolveMachineDisplayNames(machines);
      previous = retainKeyedRows(
        previous,
        machines.map((machine) => ({
          machineId: machine.id,
          name: names.get(machine.id) ?? machine.id,
          online: isMachineOnline(machine),
          installationId: machine.installationId ?? null,
          platform: machine.metadata?.platform ?? null,
        })),
        (row) => row.machineId,
      );
      return previous;
    };
  }, []);
  return useMachineListForServerSelection(serverId, select);
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
