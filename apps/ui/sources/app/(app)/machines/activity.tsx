import * as React from 'react';

import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
import { MachineFleetActivityView } from '@/components/machines/activity/MachineFleetActivityView';
import { MachinesDoorProvider } from '@/components/machines/page/machinesDoor';

/** `/machines/activity`: the fleet activity page through the rail door, beside the Machines column. */
function RailDoorMachineFleetActivityView() {
    return <MachinesDoorProvider door="rail"><MachineFleetActivityView /></MachinesDoorProvider>;
}
export { RailDoorMachineFleetActivityView as WorkspaceRouteBody };
export default function RouteEntry() { return <WorkspaceRouteEntry Body={RailDoorMachineFleetActivityView} />; }
