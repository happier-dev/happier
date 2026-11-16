import * as React from 'react';

import type { AttachmentDraft } from '@/components/sessions/attachments/attachmentDraftModel';
import { SessionSwitcherContent } from '@/components/navigation/mobile/chrome/lateralSwipe/SessionSwitcherContent';
import { useSignalSessionCockpitDismiss } from '@/hooks/session/useSignalSessionCockpitDismiss';
import type { SessionRouteHydrationState } from '@/sync/domains/session/sessionRouteHydrationState';
import type { TranscriptExperience } from '@/components/sessions/transcript/viewport/lifecycle/transcriptSameSessionHandoff';

import type { SessionMobileSurface } from './sessionCockpitState';
import { SessionCockpitTabNavigator } from './SessionCockpitTabNavigator';

type SessionCockpitShellProps = Readonly<{
    experience?: TranscriptExperience;
    sessionId: string;
    scopeId: string;
    surface: SessionMobileSurface;
    safeAreaPadding?: boolean;
    jumpToSeq?: number | null;
    jumpToMessageId?: string | null;
    initialAttachmentDrafts?: readonly AttachmentDraft[] | null;
    terminalTabAvailable?: boolean;
    routeServerId?: string | null;
    routeHydrationState?: SessionRouteHydrationState | null;
}>;

export const SessionCockpitShell = React.memo((props: SessionCockpitShellProps) => {
    useSignalSessionCockpitDismiss(props.experience === 'classic' ? '' : props.sessionId);

    // The lateral-swipe motion wraps the shell rather than anything below it: this is
    // the narrowest owner that covers header, transcript and composer together while
    // leaving the bottom bar — which lives outside the Stack — anchored under the finger.
    return (
        <SessionSwitcherContent>
            <SessionCockpitTabNavigator
                experience={props.experience}
                sessionId={props.sessionId}
                scopeId={props.scopeId}
                initialSurface={props.surface}
                safeAreaPadding={props.safeAreaPadding}
                jumpToSeq={props.jumpToSeq}
                jumpToMessageId={props.jumpToMessageId}
                initialAttachmentDrafts={props.initialAttachmentDrafts}
                terminalTabAvailable={props.terminalTabAvailable}
                routeServerId={props.routeServerId}
                routeHydrationState={props.routeHydrationState}
            />
        </SessionSwitcherContent>
    );
});
