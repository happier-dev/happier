import { useOptionalDetailsTabOpener } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { useWorkspaceOpenActions, resolveWorkspaceOpenModeFromPointer } from '@/components/appShell/workspace/useWorkspaceOpenActions';
import { createWorkspaceGalleryDetailsTab, readGalleryDetailsResource, type GalleryDetailsResource } from '@/components/appShell/panes/details/galleryDetailsTab';
import { createSessionPaneScopeId } from '@/components/sessions/panes/sessionPaneScopeId';
import { useDestinationPaneScopeId } from '@/components/appShell/workspace/DestinationInstanceHost';
import { buildSessionDetailsTabHref } from '@/components/sessions/panes/url/sessionPaneUrlState';

export function useSessionGalleryOpenActions(input: Readonly<{
    sessionId: string;
    serverId: string | null;
    resource: GalleryDetailsResource | null;
    title?: string;
}>) {
    const resource = readGalleryDetailsResource(input.resource);
    const tab = resource ? createWorkspaceGalleryDetailsTab(resource, input.title) : null;
    const href = tab ? buildSessionDetailsTabHref({ ...input, tab }) : null;
    const scopeId = useDestinationPaneScopeId(createSessionPaneScopeId(input.sessionId, input.serverId));
    const openDetailsTab = useOptionalDetailsTabOpener(scopeId);
    const workspace = useWorkspaceOpenActions(href);
    const openBeside = (): boolean => {
        if (!tab || !openDetailsTab) return false;
        openDetailsTab(tab, { origin: 'side' });
        return true;
    };
    const openGallery = (event?: unknown): boolean => {
        const mode = resolveWorkspaceOpenModeFromPointer(event);
        return mode && workspace.open(mode) ? true : openBeside();
    };
    return { tab, href, openGallery, openBeside, workspace };
}
