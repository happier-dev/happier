import * as React from 'react';

import { useOptionalDetailsTabOpener } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { openInWorkspace, useWorkspaceOpenActions, resolveWorkspaceOpenModeFromPointer } from '@/components/appShell/workspace/useWorkspaceOpenActions';
import { useWorkspaceRouterFacts } from '@/components/appShell/workspace/WorkspaceNavigationContext';
import { createWorkspaceGalleryDetailsTab, readGalleryDetailsResource, type GalleryDetailsResource } from '@/components/appShell/panes/details/galleryDetailsTab';
import { createSessionPaneScopeId } from '@/components/sessions/panes/sessionPaneScopeId';
import { useDestinationPaneScopeId } from '@/components/appShell/workspace/DestinationInstanceHost';
import { buildSessionDetailsTabHref } from '@/components/sessions/panes/url/sessionPaneUrlState';

type SessionGalleryAddress = Readonly<{ sessionId: string; serverId: string | null }>;
export type SessionGalleryOpen = (resource: GalleryDetailsResource, options?: Readonly<{ title?: string; event?: unknown; beside?: boolean }>) => boolean;

/**
 * Opens any gallery of this Session at invocation time (a folder chosen from a row menu): a plain open and Open beside
 * present the Details tab from the side; a modified pointer opens its href as a workspace tab.
 */
export function useSessionGalleryOpener(input: SessionGalleryAddress): SessionGalleryOpen {
    const scopeId = useDestinationPaneScopeId(createSessionPaneScopeId(input.sessionId, input.serverId));
    const openDetailsTab = useOptionalDetailsTabOpener(scopeId);
    const facts = useWorkspaceRouterFacts();
    const factsRef = React.useRef(facts);
    factsRef.current = facts;
    const { sessionId, serverId } = input;
    return React.useCallback<SessionGalleryOpen>((value, options) => {
        const resource = readGalleryDetailsResource(value);
        if (!resource) return false;
        const tab = createWorkspaceGalleryDetailsTab(resource, options?.title);
        const mode = options?.beside ? null : resolveWorkspaceOpenModeFromPointer(options?.event);
        if (mode && openInWorkspace(factsRef.current?.read() ?? null, buildSessionDetailsTabHref({ sessionId, serverId, tab }), mode)) return true;
        if (!openDetailsTab) return false;
        openDetailsTab(tab, { origin: 'side' });
        return true;
    }, [openDetailsTab, serverId, sessionId]);
}

export function useSessionGalleryOpenActions(input: Readonly<{
    sessionId: string;
    serverId: string | null;
    resource: GalleryDetailsResource | null;
    title?: string;
}>) {
    const resource = readGalleryDetailsResource(input.resource);
    const tab = resource ? createWorkspaceGalleryDetailsTab(resource, input.title) : null;
    const href = tab ? buildSessionDetailsTabHref({ ...input, tab }) : null;
    const open = useSessionGalleryOpener(input);
    const workspace = useWorkspaceOpenActions(href);
    const openBeside = (): boolean => resource ? open(resource, { title: input.title, beside: true }) : false;
    const openGallery = (event?: unknown): boolean => resource ? open(resource, { title: input.title, event }) : false;
    return { tab, href, openGallery, openBeside, workspace };
}
