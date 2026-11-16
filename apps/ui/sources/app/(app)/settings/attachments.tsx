import { AttachmentsSettingsView } from '@/components/settings/attachments/AttachmentsSettingsView';

export { AttachmentsSettingsView as WorkspaceRouteBody };
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export default function RouteEntry() { return <WorkspaceRouteEntry Body={AttachmentsSettingsView} />; }
