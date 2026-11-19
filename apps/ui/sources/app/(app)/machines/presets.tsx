import * as React from 'react';

import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
import { MachinesDoorProvider } from '@/components/machines/page/machinesDoor';
import { MachinePresetsIndex } from '@/components/settings/machines/presets/MachinePresetsIndex';

/** `/machines/presets`: the Presets table beside the Machines column (lab ideas-1118-platform scene 7). */
function RailDoorMachinePresetsIndex() {
    return <MachinesDoorProvider door="rail"><MachinePresetsIndex /></MachinesDoorProvider>;
}
export { RailDoorMachinePresetsIndex as WorkspaceRouteBody };
export default function RouteEntry() { return <WorkspaceRouteEntry Body={RailDoorMachinePresetsIndex} />; }
