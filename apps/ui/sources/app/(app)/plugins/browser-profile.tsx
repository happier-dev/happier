import { StoreBrowserProfileScreen } from '@/components/store/StoreBrowserProfileScreen';

// A saved browser profile's Extensions inside Store, pushed from an Installed extension row.
export { StoreBrowserProfileScreen as WorkspaceRouteBody };
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export default function RouteEntry() { return <WorkspaceRouteEntry Body={StoreBrowserProfileScreen} />; }
