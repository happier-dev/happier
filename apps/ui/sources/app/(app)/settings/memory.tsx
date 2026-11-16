import { MemorySettingsView } from '@/components/settings/memory/MemorySettingsView';

export { MemorySettingsView as WorkspaceRouteBody };
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export default function RouteEntry() { return <WorkspaceRouteEntry Body={MemorySettingsView} />; }
