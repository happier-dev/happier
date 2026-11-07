import * as React from 'react';
import { shallow } from 'zustand/shallow';
import { readStoredSessionMessagesFromStateLike } from '@happier-dev/session-core/messages';
import type { SessionListQueryV1 } from '@happier-dev/protocol/sessions/listing/query';
import { storage, useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { useSessionListQueryHomeStates } from '@/sync/domains/session/listing/useSessionListQuerySourceState';
import { readSessionListRowsForServerId } from '@/sync/domains/session/listing/sessionListRowStateLookup';
import { readVoiceConversationHistory } from './voiceConversationHistory';
import { useSessionRecordingVisibility } from '@/hooks/session/useSessionListRecordingPrivacy';
import { readStoredSessionTranscriptForAddress } from '@/sync/domains/messages/readStoredSessionMessagesForAddress';
import { projectVoiceHistoryRows } from './voiceHistoryConsumer';

const ACTIVE_QUERY: SessionListQueryV1 = {
    v: 1, storage: 'active', includeInactive: true, scope: 'my_work',
    attention: 'any', audiences: [], tagIds: [], includeAttention: false,
};
const ARCHIVED_QUERY: SessionListQueryV1 = { ...ACTIVE_QUERY, storage: 'archived' };

/** Demand-only secondary Session-list consumer. The incumbent page owners keep cursors and cancellation. */
export function useVoiceConversationHistory(query = '') {
    const isSessionVisible = useSessionRecordingVisibility();
    const scope = useActiveServerAccountScope();
    const serverId = scope?.serverId ?? '';
    const activeHomes = React.useMemo(() => serverId ? [{ serverId, query: ACTIVE_QUERY,
        queryMembership: 'rowOnly' as const, ordinaryAdapter: { path: '/v2/sessions',
            allowV1Fallback: true, membership: 'ordinary' as const } }] : [], [serverId]);
    const archivedHomes = React.useMemo(() => serverId ? [{ serverId, query: ARCHIVED_QUERY,
        queryMembership: 'rowOnly' as const, ordinaryAdapter: { path: '/v2/sessions/archived',
            allowV1Fallback: false, membership: 'archived' as const } }] : [], [serverId]);
    // Each source has one corpus per Home; combining them would deduplicate the archived corpus.
    const active = useSessionListQueryHomeStates({ enabled: Boolean(scope), homes: activeHomes });
    const archived = useSessionListQueryHomeStates({ enabled: Boolean(scope), homes: archivedHomes });
    const rows = storage(React.useCallback(state => readSessionListRowsForServerId(state.sessionListRowsByServerId, serverId), [serverId]));
    const projection = React.useMemo(() => readVoiceConversationHistory({ sessions: {},
        sessionListRowsByServerId: rows ? { [serverId]: rows } : {} }, {
        serverId, coverageComplete: active.coverageComplete && archived.coverageComplete, isSessionVisible,
    }), [active.coverageComplete, archived.coverageComplete, rows, serverId, isSessionVisible]);
    const sessionIds = React.useMemo(() => projection.conversations.map(row => row.address.sessionId), [projection.conversations]);
    const transcripts = storage(React.useCallback(state => projection.conversations.map(row =>
        readStoredSessionTranscriptForAddress(state, row.address)), [projection.conversations]),
        { sessions: sessionIds, sessionMessages: sessionIds }, shallow);
    const summaries = React.useMemo(() => projection.conversations.map((conversation, index) => {
            const transcript = transcripts[index];
            const spokenRows = projectVoiceHistoryRows(readStoredSessionMessagesFromStateLike(transcript), () => '');
            const lastText = spokenRows.map(row => row.text.trim()).filter(Boolean).at(-1);
            const lastLine = lastText?.split(/\r?\n/u).map(line => line.trim()).filter(Boolean).at(-1) ?? null;
            return { conversation: { ...conversation, title: lastLine ?? conversation.title, lastLine,
                loadedMessageCount: transcript?.isLoaded === true ? spokenRows.length : null },
                searchText: [conversation.title, ...spokenRows.map(row => row.text)].join('\n').toLocaleLowerCase() };
    }), [projection.conversations, transcripts]);
    const conversations = React.useMemo(() => {
        const normalizedQuery = query.trim().toLocaleLowerCase();
        return summaries.filter(row => !normalizedQuery || row.searchText.includes(normalizedQuery)).map(row => row.conversation);
    }, [query, summaries]);
    const loadNext = React.useCallback(async () => { await Promise.all([active.loadNext(), archived.loadNext()]); }, [active.loadNext, archived.loadNext]);
    const refresh = React.useCallback(async () => { await Promise.all([active.refresh(), archived.refresh()]); }, [active.refresh, archived.refresh]);
    const retry = React.useCallback(async () => { await Promise.all([active.retry(), archived.retry()]); }, [active.retry, archived.retry]);
    const activeState = active.statesByServerId[serverId] ?? null;
    const archivedState = archived.statesByServerId[serverId] ?? null;
    return React.useMemo(() => ({ ...projection, conversations, loadNext, refresh, retry,
        nextCursor: activeState?.hasNext || archivedState?.hasNext ? {
            active: activeState?.hasNext ? activeState.nextCursor : null,
            archived: archivedState?.hasNext ? archivedState.nextCursor : null,
        } : null,
        states: { active: activeState, archived: archivedState },
    }), [activeState, archivedState, conversations, loadNext, projection, refresh, retry]);
}
