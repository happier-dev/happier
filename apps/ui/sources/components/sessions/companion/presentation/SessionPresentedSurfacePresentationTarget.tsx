import * as React from 'react';

import { registerSessionPresentationOnlyTarget } from '@/components/sessions/presentation/sessionComposerPresentationTargets';
import { normalizeSessionAddress } from '@/sync/domains/session/sessionAddress';

import {
    SessionCompanionPresentationBridge,
    type SessionPresentationIntentApplier,
} from './SessionCompanionPresentationBridge';
import type {
    SessionBoardPresentationPort,
    SessionPresentationMutationOutcome,
} from './sessionCompanionPresentationAdapter';

/**
 * The current-UI presentation target of a Session surface presented WITHOUT a
 * Chat composer — the full-screen Board or Companion.
 *
 * It publishes the same Board/Companion bridge the Chat shell publishes, through
 * PEP's one current-UI target owner, so `chat.return`, Board view/reveal and
 * Companion intents reach a cold full-screen surface. The navigation ports are
 * the presenting shell's own (Cockpit surface switching); nothing here owns
 * binding, currentness, dedupe or acknowledgement.
 */
export const SessionPresentedSurfacePresentationTarget = React.memo(
    function SessionPresentedSurfacePresentationTarget(props: Readonly<{
        sessionId: string;
        serverId: string | null;
        /** This surface is the one presented to the viewer right now. */
        presented: boolean;
        openBoard: SessionBoardPresentationPort['open'];
        revealBoardItem: (widgetId: string) => SessionPresentationMutationOutcome;
        returnToChat: () => SessionPresentationMutationOutcome;
        openFullSurface: () => SessionPresentationMutationOutcome;
    }>) {
        const applierRef = React.useRef<SessionPresentationIntentApplier | null>(null);
        const address = React.useMemo(
            () => normalizeSessionAddress(props.serverId, props.sessionId),
            [props.serverId, props.sessionId],
        );
        React.useEffect(() => {
            if (!address || !props.presented) return;
            return registerSessionPresentationOnlyTarget(address, {
                applySessionPresentationIntent: (intent, onCompanionMutation) => (
                    applierRef.current?.(intent, onCompanionMutation) ?? { status: 'unavailable' }
                ),
                isCurrent: () => applierRef.current !== null,
            });
        }, [address, props.presented]);
        return (
            <SessionCompanionPresentationBridge
                sessionId={props.sessionId}
                serverId={props.serverId}
                applierRef={applierRef}
                openBoard={props.openBoard}
                revealBoardItem={props.revealBoardItem}
                returnToChat={props.returnToChat}
                openFullSurface={props.openFullSurface}
            />
        );
    },
);
