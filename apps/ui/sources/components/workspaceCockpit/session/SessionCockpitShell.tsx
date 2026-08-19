import * as React from 'react';

import type { AttachmentDraft } from '@/components/sessions/attachments/attachmentDraftModel';
import { SessionLateralSwipeContent } from '@/components/navigation/mobile/chrome/lateralSwipe/SessionLateralSwipeContent';
import type { SessionPaneUrlState } from '@/components/sessions/panes/url/sessionPaneUrlState';
import { useSignalSessionCockpitDismiss } from '@/hooks/session/useSignalSessionCockpitDismiss';
import type { SessionRouteHydrationState } from '@/sync/domains/session/sessionRouteHydrationState';

import type { SessionMobileSurface } from './sessionCockpitState';
import { SessionCockpitTabNavigator } from './SessionCockpitTabNavigator';

type SessionCockpitShellProps = Readonly<{
    sessionId: string;
    scopeId: string;
    surface: SessionMobileSurface;
    routeServerId?: string | null;
    safeAreaPadding?: boolean;
    jumpToSeq?: number | null;
    paneUrlState?: SessionPaneUrlState | null;
    initialAttachmentDrafts?: readonly AttachmentDraft[] | null;
    terminalTabAvailable?: boolean;
    routeHydrationState?: SessionRouteHydrationState | null;
}>;

export const SessionCockpitShell = React.memo((props: SessionCockpitShellProps) => {
    useSignalSessionCockpitDismiss(props.sessionId);

    // The lateral-swipe motion wraps the shell rather than anything below it: this is
    // the narrowest owner that covers header, transcript and composer together while
    // leaving the bottom bar — which lives outside the Stack — anchored under the finger.
    return (
        <SessionLateralSwipeContent>
            <SessionCockpitTabNavigator
                sessionId={props.sessionId}
                scopeId={props.scopeId}
                initialSurface={props.surface}
                routeServerId={props.routeServerId}
                safeAreaPadding={props.safeAreaPadding}
                jumpToSeq={props.jumpToSeq}
                paneUrlState={props.paneUrlState}
                initialAttachmentDrafts={props.initialAttachmentDrafts}
                terminalTabAvailable={props.terminalTabAvailable}
                routeHydrationState={props.routeHydrationState}
            />
        </SessionLateralSwipeContent>
    );
});
