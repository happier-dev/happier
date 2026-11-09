import * as React from 'react';

import { SessionPendingPromptCards } from '@/components/tools/shell/permissions/SessionPendingPromptCards';
import { AppSessionTranscriptSourceProvider } from '@/components/sessions/transcript/source/appSessionTranscriptSource';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import { useSession, useSessionMessages } from '@/sync/domains/state/storage';
import { listPendingPermissionRequests, listPendingUserActionRequests } from '@/utils/sessions/sessionUtils';

/**
 * One exact session's waiting requests (permission and user-action prompts), through the canonical
 * request readers. `prompts` is null while there is nothing to decide.
 */
export function useSessionPendingPrompts(address: SessionAddress) {
    const session = useSession(address.sessionId, address.serverId);
    // Waiting requests are request rows; streamed text never changes them.
    const { messages } = useSessionMessages(address.sessionId, { textUpdates: false });
    const prompts = React.useMemo(() => {
        if (!session) return null;
        const permissions = listPendingPermissionRequests(session, messages);
        const userActions = listPendingUserActionRequests(session, messages);
        return permissions.length + userActions.length > 0 ? { permissions, userActions } : null;
    }, [messages, session]);
    return { session, prompts };
}

/**
 * Needs you, in the Voice section (lab `voice-moments` N1): the conversation's waiting requests as the
 * real request cards, through the session's own approval custody. Spoken decisions use the same
 * owner under VI-04; the cards remain available for a person to decide here.
 *
 * Mounted only while the attempt projection reports Needs you for its exact conversation, so the
 * session's messages are read only while there is something to decide.
 */
export const VoiceNeedsYouPrompts = React.memo(function VoiceNeedsYouPrompts(props: Readonly<{
    address: SessionAddress;
    testID: string;
}>) {
    const { session, prompts } = useSessionPendingPrompts(props.address);
    if (!session || !prompts) return null;
    return (
        // Voice can sit beside a different Session's transcript. The exact
        // conversation owns request data, navigation and approval custody.
        <AppSessionTranscriptSourceProvider sessionId={props.address.sessionId} serverId={props.address.serverId}>
            <SessionPendingPromptCards
                testID={props.testID}
                sessionId={props.address.sessionId}
                serverId={props.address.serverId}
                session={session}
                permissions={prompts.permissions}
                userActions={prompts.userActions}
                chrome="card"
            />
        </AppSessionTranscriptSourceProvider>
    );
});
