import * as React from 'react';
import { useRouter, type Href } from '@/components/appShell/workspace/destinationRoute';

import type { AppPaneScopeApi } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { useSessionCockpitSurfaceNavigation } from '@/components/workspaceCockpit/session/SessionCockpitSurfaceNavigation';
import { buildSessionDestinationRouteHref } from '@/components/workspaceCockpit/session/sessionCockpitNavigation';
import { useMobileWorkspaceExperienceState } from '@/components/workspaceCockpit/useMobileWorkspaceExperienceState';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import {
    publishSessionCollaborationIntent,
    type SessionCollaborationFocusTarget,
    type SessionCollaborationHandoff,
} from './sessionCollaborationIntent';

/**
 * `collaborationFocus` is written and consumed only here. It carries a one-shot
 * semantic focus intent to a destination that may not be mounted yet, exactly
 * like the in-process intent mailbox — never continuing mode state.
 *
 * Unqualified legacy input stays unqualified so the Session root resolves its Home.
 */
export function buildSessionCollaborationRouteHref(input: Readonly<{
    sessionId: string;
    serverId?: string | null;
    cockpitEnabled: boolean;
    focusTarget?: SessionCollaborationFocusTarget;
    shareDirectory?: 'team';
}>): string {
    // `top` is the ordinary entry: it selects the destination's default mode and
    // requests no focus move, so it carries no one-shot semantic focus intent.
    const query = {
        ...(input.shareDirectory ? { shareDirectory: input.shareDirectory } : {}),
        ...(input.focusTarget && input.focusTarget !== 'top' ? { collaborationFocus: input.focusTarget } : {}),
    };
    return buildSessionDestinationRouteHref({
        sessionId: input.sessionId,
        serverId: input.serverId,
        cockpitEnabled: input.cockpitEnabled,
        surface: 'collaboration',
        rightTabId: 'collaboration',
        query,
    });
}

/**
 * Consumes the route half of that one-shot intent once the destination applied it.
 *
 * `setParams` rewrites this single key on the current route entry, so unrelated
 * query state and the history stack are untouched — a replace would push the same
 * Session through navigation again purely to drop a consumed flag. Without this
 * the key survives in the URL, and every remount, Back, or later revisit of the
 * Session would force Access again over the mode the user actually chose.
 */
export function useConsumeSessionCollaborationRouteFocus(): () => void {
    const router = useRouter();
    return React.useCallback(() => {
        router.setParams({ collaborationFocus: undefined });
    }, [router]);
}

/**
 * One exact-target command shared by the Session header, composer and detached routes.
 *
 * The returned command takes an options bag rather than a positional handoff
 * value because it is also wired straight to press handlers (`Item`, the header
 * entry, and the composer chip's `onOpen`, which calls it with its focus-return
 * ref). Those callers hand it an object that simply carries no `query`.
 */
export function useOpenSessionCollaboration(input: Readonly<{
    /**
     * The exact Session. A released deep link may be unqualified, in which case
     * the destination stays unqualified and the Session root resolves its Home;
     * a mounted pane or Cockpit surface always has the qualified target.
     */
    target: SessionAddress | Readonly<{ serverId?: string | null; sessionId: string }> | null;
    /** Only supply the pane when this exact Session is the mounted source. */
    pane?: Pick<AppPaneScopeApi, 'openRight' | 'setRightTab'>;
    replace?: boolean;
    focusTarget?: SessionCollaborationFocusTarget;
    shareDirectory?: 'team';
}>): (handoff?: SessionCollaborationHandoff) => void {
    const router = useRouter();
    const cockpitNavigation = useSessionCockpitSurfaceNavigation();
    const switchCockpitSurface = cockpitNavigation?.switchSurface;
    const { cockpitEnabled } = useMobileWorkspaceExperienceState();
    const serverId = input.target?.serverId;
    const sessionId = input.target?.sessionId;
    const openRight = input.pane?.openRight;
    const setRightTab = input.pane?.setRightTab;
    const replace = input.replace === true;
    const focusTarget = input.focusTarget ?? 'top';
    const shareDirectory = input.shareDirectory;

    return React.useCallback((handoff?: SessionCollaborationHandoff) => {
        if (!sessionId) return;
        if (serverId) {
            // The query stays in the in-process mailbox only: a private roster
            // search is mounted-surface state, not route state.
            publishSessionCollaborationIntent({ serverId, sessionId }, focusTarget, handoff?.query);
        }
        if (serverId && openRight && switchCockpitSurface) {
            switchCockpitSurface('collaboration');
            return;
        }
        if (serverId && openRight && setRightTab) {
            openRight({ tabId: 'collaboration' });
            setRightTab('collaboration');
            return;
        }
        const href = buildSessionCollaborationRouteHref({ sessionId, serverId, cockpitEnabled, focusTarget, shareDirectory });
        if (replace) router.replace(href as Href);
        else router.push(href as Href);
    }, [cockpitEnabled, switchCockpitSurface, focusTarget, openRight, replace, router, serverId, sessionId, setRightTab, shareDirectory]);
}
