import { useOptionalAuth } from '@/auth/context/AuthContext';
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
import { ProjectSourcesScreen } from '@/components/projects/sources/ProjectSourcesScreen';

/** Public Source setup landing; its consumer owns exact-Home authentication before reading. */
function ProjectSourceSetupBody() { return <ProjectSourcesScreen setupLink />; }

export { ProjectSourceSetupBody as WorkspaceRouteBody };
export default function RouteEntry() {
    // Signed out, a setup link is one step of the welcome shell (its states draw their own frame), not a workspace page.
    const signedIn = useOptionalAuth()?.isAuthenticated === true;
    return signedIn ? <WorkspaceRouteEntry Body={ProjectSourceSetupBody} /> : <ProjectSourceSetupBody />;
}
