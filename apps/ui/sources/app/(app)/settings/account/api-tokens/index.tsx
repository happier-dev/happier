import { ApiTokensSettingsIndex } from '@/components/settings/apiTokens/collection/ApiTokensSettingsIndex';

export { ApiTokensSettingsIndex as WorkspaceRouteBody };
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export default function RouteEntry() { return <WorkspaceRouteEntry Body={ApiTokensSettingsIndex} />; }
