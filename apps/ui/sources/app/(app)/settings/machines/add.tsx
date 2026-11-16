import { MachineAddDraftScreen } from '@/components/machines/add/MachineAddDraftScreen';

export { MachineAddDraftScreen as WorkspaceRouteBody };
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export default function RouteEntry() { return <WorkspaceRouteEntry Body={MachineAddDraftScreen} />; }
