import * as React from 'react';
import type { SessionActivityAttention } from '@/activity/attention/activityAttentionTypes';
import { buildInboxReadySessionResult, readInboxReadySessionTurnId, readInboxReadySessionTurn, readInboxReadySessionMessage, type InboxReadySessionResult } from '@/activity/presentation/buildInboxReadySessionResult';
import type { Message } from '@happier-dev/session-core/messages';
import { storage } from '@/sync/domains/state/storageStore';
import { useWorkflowRun } from '@/sync/store/hooks';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { selectActiveServerAccountScopeForServer } from '@/sync/domains/scope/activeServerAccountScope';
import { normalizeSessionAddress, type SessionAddress } from '@/sync/domains/session/sessionAddress';
import { useSessionContentDemand } from '@/sync/domains/session/useSessionContentDemand';
import { resolveWorkflowRunDisplayName } from '@/components/workflows/presentation/workflowRunDisplayName';
import { useSessionRealtimeTranscriptConsumer } from '@/hooks/session/useSessionRealtimeTranscriptConsumer';
import { useHydrateSession } from '@/hooks/session/useHydrateSessionForRoute';

const NO_ADDRESSES: readonly SessionAddress[] = [];
const NO_SESSION_IDS: readonly string[] = [];
const UNAVAILABLE_RESULT: InboxReadySessionResult = Object.freeze({ preview: Object.freeze({ state: 'unavailable' }),
    workflowInvocation: null, completedAt: null });

/** Visible result rows demand their selected reply; an opened receipt demands its exact transcript. */
export function useInboxReadySessionResult(
    candidate: SessionActivityAttention | null,
    options: Readonly<{ active?: boolean; transcriptAddress?: SessionAddress | null; selection?: 'latestTurn' }> = {},
): InboxReadySessionResult {
    const active = options.active !== false;
    const sessionId = candidate?.sessionId ?? '';
    const serverId = candidate?.address?.serverId ?? candidate?.serverId ?? null;
    const address = normalizeSessionAddress(serverId, sessionId);
    const transcriptAddress = options.transcriptAddress;
    const resultTurnId = !transcriptAddress && candidate
        ? readInboxReadySessionTurnId(candidate, options.selection) ?? undefined
        : undefined;
    useSessionRealtimeTranscriptConsumer(active ? transcriptAddress?.sessionId : null, transcriptAddress?.serverId);
    useHydrateSession(active ? transcriptAddress?.sessionId ?? '' : '', 'inbox-ready-session-result', {
        serverId: transcriptAddress?.serverId,
        hydrateMessages: true,
        includeTurnsProjection: true,
    });
    useSessionContentDemand(address ? [address] : NO_ADDRESSES, {
        tag: 'inbox.hydrateReadySessionRow', hydrate: 'unsettled', active,
        resultTurnId,
    });
    const turns = storage(state => {
        if (!active || !candidate) return null;
        const session = state.sessions[sessionId];
        return session && areServerProfileIdentifiersEquivalent(session.serverId, serverId) ? session.sessionTurns : null;
    }, { sessions: candidate ? [sessionId] : NO_SESSION_IDS });
    const turn = candidate ? readInboxReadySessionTurn(candidate, turns, options.selection) : null;
    const selectMessage = React.useMemo(() => {
        let ids: readonly string[] | undefined;
        let selected: Message | null = null;
        return (state: ReturnType<typeof storage.getState>): Message | null => {
            if (!active || !turn) return null;
            const transcript = state.sessionMessages[sessionId];
            // Text arrivals retain ids and message identities. The known result is
            // then one keyed read; a newly loaded page can supply a later block.
            if (selected && ids === transcript?.messageIdsOldestFirst) {
                const current = transcript?.messagesById[selected.id];
                if (current) return current;
            }
            ids = transcript?.messageIdsOldestFirst;
            selected = readInboxReadySessionMessage(turn, transcript ? Object.values(transcript.messagesById) : undefined);
            return selected;
        };
    }, [active, turn, sessionId]);
    const message = storage(selectMessage, { sessionMessages: active && turn ? [sessionId] : NO_SESSION_IDS });
    const profileScope = storage(state => state.profileScope);
    const scope = selectActiveServerAccountScopeForServer(profileScope, serverId);
    const run = useWorkflowRun(turn?.workflowInvocation?.runId, { enabled: active && scope !== null, scope });
    return React.useMemo(() => candidate ? buildInboxReadySessionResult({ candidate, turns, selection: options.selection,
        messages: message ? [message] : undefined,
        resolveWorkflowName: () => {
            const name = resolveWorkflowRunDisplayName(run?.metadata);
            return name.kind === 'name' ? name.value : undefined;
        },
    }) : UNAVAILABLE_RESULT, [candidate, turns, message, options.selection, run?.metadata]);
}
