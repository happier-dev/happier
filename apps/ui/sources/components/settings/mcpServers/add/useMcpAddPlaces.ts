import * as React from 'react';
import { getAgentToolsCapability } from '@happier-dev/agents';
import { agentReceivesUserMcpServersV1 } from '@happier-dev/protocol/plugins/contributions/v2';

import { useWhereItsOnNames } from '@/components/capabilities/where/useWhereItsOnNames';
import { useReachMachines, type ReachMachine } from '@/sync/domains/capabilities/reach/useReachProjection';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';

/** Saved and draft reach use the same declared delivery fact, including configured ACP carriers. */
export function useMcpAgentTakes(machines: readonly ReachMachine[]) {
  return React.useCallback((agentId: string): 'full' | 'none' => {
    let installed = false;
    for (const machine of machines) {
      if (!machine.agentIds.includes(agentId)) continue;
      installed = true;
      const declaration = machine.agentDeclarationsById?.[agentId];
      const delivery = declaration ? declaration.capabilities?.tools?.delivery : getAgentToolsCapability(agentId)?.delivery;
      if (agentReceivesUserMcpServersV1(delivery)) return 'full';
    }
    return !installed && agentReceivesUserMcpServersV1(getAgentToolsCapability(agentId)?.delivery) ? 'full' : 'none';
  }, [machines]);
}

/** Machines, their names and which Agents take user MCP servers (IR-80): what Where it's on offers in the Add modal. */
export function useMcpAddPlaces() {
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
    serverId: scope?.serverId ?? null,
  });
  const agentTakes = useMcpAgentTakes(machines);
  return React.useMemo(
    () => ({ machines, placeMachines, projects, workspaceRefs, agentIds, names, agentTakes }),
    [machines, placeMachines, projects, workspaceRefs, agentIds, names, agentTakes],
  );
}

export type McpAddPlaces = ReturnType<typeof useMcpAddPlaces>;
