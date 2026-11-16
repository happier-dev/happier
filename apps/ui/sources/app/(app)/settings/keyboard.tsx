import { KeyboardShortcutsSettingsView } from '@/components/settings/keyboard/KeyboardShortcutsSettingsView';

export { KeyboardShortcutsSettingsView as WorkspaceRouteBody };
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export default function RouteEntry() { return <WorkspaceRouteEntry Body={KeyboardShortcutsSettingsView} />; }
