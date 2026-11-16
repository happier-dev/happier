import { DiagnosisView } from '@/components/settings/diagnosis/DiagnosisView';

export { DiagnosisView as WorkspaceRouteBody };
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export default function RouteEntry() { return <WorkspaceRouteEntry Body={DiagnosisView} />; }
