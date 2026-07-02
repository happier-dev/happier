import * as React from 'react';

import type { AttachmentDraft } from '@/components/sessions/attachments/attachmentDraftModel';
import type { SessionPaneUrlState } from '@/components/sessions/panes/url/sessionPaneUrlState';
import type { SessionRouteHydrationState } from '@/sync/domains/session/sessionRouteHydrationState';

import type { SessionMobileSurface } from './sessionCockpitState';
import { SessionCockpitTabNavigator } from './SessionCockpitTabNavigator';

type SessionCockpitShellProps = Readonly<{
    sessionId: string;
    scopeId: string;
    surface: SessionMobileSurface;
    safeAreaPadding?: boolean;
    jumpToSeq?: number | null;
    paneUrlState?: SessionPaneUrlState | null;
    initialAttachmentDrafts?: readonly AttachmentDraft[] | null;
    terminalTabAvailable?: boolean;
    routeServerId?: string | null;
    routeHydrationState?: SessionRouteHydrationState | null;
}>;

export const SessionCockpitShell = React.memo((props: SessionCockpitShellProps) => (
    <SessionCockpitTabNavigator
        sessionId={props.sessionId}
        scopeId={props.scopeId}
        initialSurface={props.surface}
        safeAreaPadding={props.safeAreaPadding}
        jumpToSeq={props.jumpToSeq}
        paneUrlState={props.paneUrlState}
        initialAttachmentDrafts={props.initialAttachmentDrafts}
        terminalTabAvailable={props.terminalTabAvailable}
        routeServerId={props.routeServerId}
        routeHydrationState={props.routeHydrationState}
    />
));
