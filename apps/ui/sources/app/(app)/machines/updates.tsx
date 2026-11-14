import * as React from 'react';

import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
import { MachineFleetUpdatesView } from '@/components/machines/updates/MachineFleetUpdatesView';
import { MachinesDoorProvider } from '@/components/machines/page/machinesDoor';

/** `/machines/updates`: the fleet updates page through the rail door, beside the Machines column. */
function RailDoorMachineFleetUpdatesView() {
    return <MachinesDoorProvider door="rail"><MachineFleetUpdatesView /></MachinesDoorProvider>;
}
export { RailDoorMachineFleetUpdatesView as WorkspaceRouteBody };
export default function RouteEntry() { return <WorkspaceRouteEntry Body={RailDoorMachineFleetUpdatesView} />; }
