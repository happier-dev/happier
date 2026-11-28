import * as React from 'react';

import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { useOptionalAppPaneScopeLayout } from '@/components/appShell/panes/hooks/useAppPaneScopeLayout';
import { useDestinationPathname, useDestinationRouter } from '@/components/appShell/workspace/DestinationInstanceHost';
import { parseSessionPaneScopeId } from '@/components/sessions/panes/sessionPaneScopeId';
import { useSessionCockpitSurfaceNavigation } from '@/components/workspaceCockpit/session/SessionCockpitSurfaceNavigation';
import { resolveSessionRoutePathForSurface } from '@/components/workspaceCockpit/session/sessionCockpitState';

/**
 * Brings a Session's chat in front of the person, from whatever covers it: a phone switches to the chat
 * surface, a Details drawer or overlay side pane over the Session closes, and a full-page reading gives way
 * to the Session. A reading docked beside the visible Session stays where it is. Pane state (open tabs,
 * their scroll) is retained either way.
 */
export function useSessionChatReveal(scopeId: string): () => void {
    const { closeDetails, closeRight } = useAppPaneScope(scopeId);
    const cockpitNavigation = useSessionCockpitSurfaceNavigation();
    const pathname = useDestinationPathname();
    const router = useDestinationRouter();
    // Read at call time: the decision follows the layout the person sees when they ask.
    const layout = useOptionalAppPaneScopeLayout();
    const layoutRef = React.useRef(layout);
    layoutRef.current = layout;
    return React.useCallback(() => {
        const session = parseSessionPaneScopeId(scopeId);
        const fullPageReading = !cockpitNavigation && session !== null
            && pathname === `/session/${encodeURIComponent(session.sessionId)}/details`;
        const current = layoutRef.current;
        const readingDockedBesideSession = !fullPageReading && current != null && current.effectiveDetailsOpen
            && !current.mainHidden && current.layout.main === 'docked' && current.layout.details === 'docked';
        if (!readingDockedBesideSession) closeDetails();
        if (!readingDockedBesideSession || current?.layout.right === 'overlay') closeRight();
        cockpitNavigation?.switchSurface('chat');
        if (fullPageReading && session) {
            router.replace(resolveSessionRoutePathForSurface(session.sessionId, 'chat', { serverId: session.address?.serverId }));
        }
    }, [closeDetails, closeRight, cockpitNavigation, pathname, router, scopeId]);
}
