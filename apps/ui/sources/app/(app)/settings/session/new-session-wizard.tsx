import { NewSessionWizardSettingsView } from '@/components/settings/session/NewSessionWizardSettingsView';

export { NewSessionWizardSettingsView as WorkspaceRouteBody };
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export default function RouteEntry() { return <WorkspaceRouteEntry Body={NewSessionWizardSettingsView} />; }
