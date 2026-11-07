import { StoreScreen } from '@/components/store/StoreScreen';

// The main sidebar's Store destination. Kind pages are the Store's own; the rest is the Plugins home
// hosted as an app page. Links inside it stay in this host (`pluginsSurfaceRoutes`).
export const WorkspaceRouteBody = StoreScreen;
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export default function RouteEntry() { return <WorkspaceRouteEntry Body={WorkspaceRouteBody} />; }
