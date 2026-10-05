import { PersonalizeRouteScreen as WorkspaceRouteBody } from '@/components/onboarding/personalize/PersonalizeRouteScreen';
export { WorkspaceRouteBody };
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export default function RouteEntry() { return <WorkspaceRouteEntry Body={WorkspaceRouteBody} />; }
