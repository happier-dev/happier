import * as React from 'react';

import { SessionPendingPromptCards } from '@/components/tools/shell/permissions/SessionPendingPromptCards';
import { listSessionSubagentPendingPrompts } from '@/sync/domains/session/subagents/deriveSessionSubagentPendingAttentionKinds';
import type { SessionSubagent } from '@/sync/domains/session/subagents/types';
import { useSessionMessages } from '@/sync/domains/state/storage';
import type { Session } from '@/sync/domains/state/storageTypes';
import { useSessionMessagesReducerState } from '@/sync/store/hooks';
import { listPendingPermissionRequests, listPendingUserActionRequests } from '@/utils/sessions/sessionUtils';

/**
 * What a needs-you row is waiting on, answered in place (agents lab SG).
 *
 * Mounted only while the row is open, so the Session's pending requests and the subagent's
 * transcript are read only when someone looks. It draws each prompt through the canonical prompt
 * owners — the same Allow / Deny and answer controls the composer and the Inbox show — so the
 * roster adds no second way to answer a prompt. When none of the waiting prompts can be answered
 * here (an Execution Run answers its own prompts on its page) it renders the host's `fallback`,
 * which offers to open the work instead.
 */
export const SessionAgentPendingPrompts = React.memo((props: Readonly<{
    sessionId: string;
    serverId?: string | null;
    session: Session | null;
    subagent: SessionSubagent;
    /** Rendered when nothing waiting can be answered from here. */
    fallback: React.ReactNode;
}>) => {
    const { messages } = useSessionMessages(props.sessionId);
    const reducerState = useSessionMessagesReducerState(props.sessionId);
    const { session, subagent } = props;

    const prompts = React.useMemo(() => {
        if (!session) return { permissions: [], userActions: [] };
        const waitingIds = new Set(
            listSessionSubagentPendingPrompts({ subagent, reducerState, messages }).map((prompt) => prompt.id),
        );
        return {
            permissions: listPendingPermissionRequests(session, messages).filter((request) => waitingIds.has(request.id)),
            userActions: listPendingUserActionRequests(session, messages).filter((request) => waitingIds.has(request.id)),
        };
    }, [messages, reducerState, session, subagent]);
    if (!session || (prompts.permissions.length === 0 && prompts.userActions.length === 0)) {
        return <>{props.fallback}</>;
    }

    return (
        <SessionPendingPromptCards
            testID={`session-subagent-prompts:${subagent.id}`}
            sessionId={props.sessionId}
            serverId={props.serverId}
            session={session}
            permissions={prompts.permissions}
            userActions={prompts.userActions}
        />
    );
});
