import * as React from 'react';
import type { DiscussionAnchorV1 } from '@happier-dev/protocol/discussions';

import { useGlobalSearchParams, usePathname, useRouter, type Href } from '@/components/appShell/workspace/destinationRoute';
import type { DiscussionHomeAddress } from './discussionDetailsTarget';
import { buildDiscussionRouteHref, type DiscussionSourceSurface } from './discussionRoutes';
import { useOptionalDetailsTabOpener } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { useOptionalAppPaneContext } from '@/components/appShell/panes/AppPaneContext';
import { buildDetailsWorkspaceStateView } from '@/components/appShell/panes/details/workspace/detailsWorkspaceSelectors';
import { useDestinationPaneScopeId } from '@/components/appShell/workspace/DestinationInstanceHost';
import { createSessionPaneScopeId } from '@/components/sessions/panes/sessionPaneScopeId';
import { createSessionDiscussionDetailsTab } from '@/components/sessions/panes/details/sessionDetailsTabBuilders';
import { sessionAddressKey } from '@/sync/domains/session/sessionAddress';
import { useDeviceType } from '@/utils/platform/responsive';
import { randomUUID } from '@/platform/randomUUID';
import type { DiscussionDetailsTarget } from './discussionDetailsTarget';

export { buildDiscussionRouteHref, buildDiscussionsRouteHref } from './discussionRoutes';

/** Home, People and Inbox open the same resource on every layout. */
export function useOpenDiscussion(input: Readonly<{
    address: DiscussionHomeAddress;
    anchor?: DiscussionAnchorV1;
    sourceSurface?: DiscussionSourceSurface;
    /** An explicit entry may seed its own fresh document before navigation. Never runs on mount. */
    prepareNewDraft?: (draftId: string) => void;
    /** A source modal retains the originating destination's pane occurrence. */
    paneScopeId?: string;
}>): Readonly<{
    openNewDiscussion: () => void;
    openDiscussion: (discussionId: string, title?: string | null, messageId?: string) => void;
    activeDiscussionKey: string | null;
}> {
    const router = useRouter();
    const pathname = usePathname();
    // The open Discussion is the route's: the Discussions column stands outside the route's own screen.
    const params = useGlobalSearchParams<{ serverId?: string | string[]; discussionId?: string | string[] }>();
    const { serverId } = input.address;
    const { anchor, sourceSurface, prepareNewDraft } = input;
    const deviceType = useDeviceType();
    const sessionId = anchor?.kind === 'session' ? anchor.sessionId : null;
    // Home/Inbox/phone callers do not require a pane host. An anchored desktop
    // entry uses the existing pane owner only when that host is available.
    const destinationScopeId = useDestinationPaneScopeId(sessionId ? createSessionPaneScopeId(sessionId, serverId) : '');
    const scopeId = input.paneScopeId ?? destinationScopeId;
    const openDetailsTab = useOptionalDetailsTabOpener(scopeId);
    const details = useOptionalAppPaneContext(value => value.state.scopes[scopeId]?.details ?? null);
    const activeTabKey = React.useMemo(() => details ? buildDetailsWorkspaceStateView(details).activeTabKey : null, [details]);
    const inSessionPane = sessionId !== null && deviceType !== 'phone' && openDetailsTab !== null;
    const prefix = sessionId ? `discussion:${sessionAddressKey({ serverId, sessionId })}:` : null;
    const tabKey = prefix && activeTabKey?.startsWith(prefix) ? activeTabKey.slice(prefix.length) : null;
    const activeDiscussionKey = inSessionPane ? tabKey?.startsWith('new:') ? 'new' : tabKey
        : params.serverId !== serverId ? null
        : pathname === '/discussions/new' ? 'new'
        : pathname.startsWith('/discussions/') && typeof params.discussionId === 'string'
            ? params.discussionId : null;
    const openTarget = React.useCallback((target: DiscussionDetailsTarget, title?: string | null) => {
        if (inSessionPane && sessionId && openDetailsTab) {
            openDetailsTab(createSessionDiscussionDetailsTab({ ...target, address: { serverId, sessionId }, title }), { intent: 'preview' });
        } else {
            router.push(buildDiscussionRouteHref({ target, sourceSurface }) as Href);
        }
    }, [inSessionPane, openDetailsTab, router, serverId, sessionId, sourceSurface]);
    const actions = React.useMemo(() => ({
        openNewDiscussion: () => {
            const draftId = randomUUID();
            prepareNewDraft?.(draftId);
            openTarget({ kind: 'new', address: { serverId }, draftId, ...(anchor ? { anchor } : {}) });
        },
        openDiscussion: (discussionId: string, title?: string | null, messageId?: string) => openTarget({
            kind: 'discussion', address: { serverId }, discussionId, ...(messageId ? { messageId } : {}),
        }, title),
    }), [anchor, openTarget, prepareNewDraft, serverId]);
    return { ...actions, activeDiscussionKey };
}
