import { PromptProfileStacksScreen } from '@/components/settings/prompts/stacks/PromptProfileStacksScreen';

export { PromptProfileStacksScreen as WorkspaceRouteBody };
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export default function RouteEntry() { return <WorkspaceRouteEntry Body={PromptProfileStacksScreen} />; }
