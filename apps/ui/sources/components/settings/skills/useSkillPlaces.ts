import * as React from 'react';

import { useWhereItsOnNames } from '@/components/capabilities/where/useWhereItsOnNames';
import { useReachMachines } from '@/sync/domains/capabilities/reach/useReachProjection';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';

import { skillPlanOnMachine } from './skillsCollectionModel';

/** Machines, their names and which Agents can take skills there: shared by the saved page, the draft and the Add modal. */
export function useSkillPlaces(serverId?: string | null) {
  const scope = useAccountSettingsScope();
  const { machines, placeMachines: machineNames, agentIds } = useReachMachines();
  const placeMachines = React.useMemo(
    () =>
      machines.map((machine) => ({
        machineId: machine.machineId,
        name: machine.name ?? machine.machineId,
        online: machine.online,
      })),
    [machines],
  );
  const { names, projects, workspaceRefs } = useWhereItsOnNames({
    agentIds,
    machines: machineNames,
    serverId: serverId ?? scope?.serverId ?? null,
  });
  // IR-80: an Agent takes skills when some machine's plan for it is not `none`.
  const agentTakes = React.useCallback(
    (agentId: string): 'full' | 'index' | 'none' => {
      let seen = false;
      for (const machine of machines) {
        if (!machine.agentIds.includes(agentId)) continue;
        seen = true;
        const kind = skillPlanOnMachine(machine, agentId);
        if (kind !== 'none') return kind === 'session_dir' ? 'full' : kind;
      }
      return seen ? 'none' : 'full';
    },
    [machines],
  );
  return { machines, placeMachines, projects, workspaceRefs, agentIds, names, agentTakes } as const;
}
