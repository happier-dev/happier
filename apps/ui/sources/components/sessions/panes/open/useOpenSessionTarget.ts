import * as React from 'react';
import { useRouter } from 'expo-router';

import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { resolveSessionPaneScopeId } from '@/components/sessions/panes/sessionPaneScopeId';

import { resolveSessionOpenPlacement, type SessionOpenTarget } from './sessionOpenTarget';
import { useSessionOpenLayout } from './useSessionOpenLayout';

export type SessionTargetOpener = (
    target: SessionOpenTarget,
    options?: Readonly<{ intent?: 'default' | 'pinned' | 'preview' }>,
) => boolean;

/**
 * Open something belonging to a session, wherever this layout can put it.
 *
 * This is the hook form of the one decision in `sessionOpenTarget.ts`, and the only thing it adds is
 * the effect: read the layout, resolve the placement, then push or dispatch. Every session surface
 * that opens something goes through it — the transcript's file and reference links, the header's
 * agents button and its folded menu twin, the compact work-state popover, and the Agents pane — so a
 * press behaves the same wherever it is drawn and no host has to know whether it is inside a pane.
 *
 * **The pane scope is addressed by id, not inherited from a host.** That is what lets the popover —
 * anchored to the composer, outside every pane — open a details tab on a wide layout, the same way a
 * transcript file link already did. A host with no pane to open is not a different host; it is the
 * same call reaching a layout that resolves to a route instead.
 *
 * Returns whether anything was opened, so a caller that must report handled/unhandled (the header's
 * overflow menu) does not have to re-derive the answer, and a target that resolves nothing stays
 * silent instead of pretending.
 */
export function useOpenSessionTarget(params: Readonly<{
    sessionId: string;
    /** Defaults to this session's canonical pane scope. */
    scopeId?: string;
    /** Kept on every route this pushes, so a multi-server deep link survives the jump. */
    serverId?: string | null;
}>): SessionTargetOpener {
    const { serverId, sessionId } = params;
    const router = useRouter();
    // The pane HOST's own normalization, not the raw device type — see `useSessionOpenLayout`.
    const layout = useSessionOpenLayout();
    const scopeId = params.scopeId ?? resolveSessionPaneScopeId(sessionId);
    const pane = useAppPaneScope(scopeId);

    return React.useCallback((target, options) => {
        const placement = resolveSessionOpenPlacement({
            sessionId,
            ...(serverId ? { serverId } : null),
            target,
            layout,
        });
        if (!placement) return false;

        if (placement.kind === 'route') {
            router.push(placement.href as never);
            return true;
        }
        if (placement.kind === 'detailsTab') {
            pane.openDetailsTab(placement.tab, options?.intent ? { intent: options.intent } : undefined);
            return true;
        }
        pane.openRight({ tabId: placement.tabId });
        pane.setRightTab(placement.tabId);
        return true;
    }, [layout, pane, router, serverId, sessionId]);
}
