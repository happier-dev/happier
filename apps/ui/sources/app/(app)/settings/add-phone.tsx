import { AddPhoneSettingsView } from '@/components/settings/account/AddPhoneSettingsView';

export { AddPhoneSettingsView as WorkspaceRouteBody };
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export default function RouteEntry() { return <WorkspaceRouteEntry Body={AddPhoneSettingsView} />; }
