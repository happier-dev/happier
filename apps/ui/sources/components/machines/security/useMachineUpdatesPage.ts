import * as React from 'react';
import type { MachineSetupObservationV1 } from '@happier-dev/protocol/machines/setup/machineSetupObservationV1';
import { useMachineFieldPage } from '@/sync/store/useMachineFieldPage';

export type MachineUpdatesPageEntry = Readonly<{
  machineId: string;
  observation: NonNullable<MachineSetupObservationV1['updates']> | null;
}>;

/** Existing pushed update facts for the visible page. Native checking remains an explicit per-Machine Action. */
export function useMachineUpdatesPage(input: Readonly<{
  serverId: string; machineIds: readonly string[]; enabled: boolean;
}>): readonly MachineUpdatesPageEntry[] {
  const fields = useMachineFieldPage(input.machineIds, 'daemonState', 'setup', input);
  const previous = React.useRef<readonly MachineUpdatesPageEntry[]>([]);
  return React.useMemo(() => {
    const next = fields.map((setup, index) => {
      const machineId = input.machineIds[index]!.trim();
      const observation = setup?.updates ?? null;
      const retained = previous.current[index];
      return retained?.machineId === machineId && retained.observation === observation ? retained : { machineId, observation };
    });
    if (next.length === previous.current.length && next.every((entry, index) => entry === previous.current[index])) return previous.current;
    previous.current = next;
    return next;
  }, [fields, input.machineIds]);
}
