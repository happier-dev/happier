import React from 'react';
import { useSessionUserMessageHistory } from '@/sync/store/hooks';
import { compareTranscriptMessagesOldestFirst } from '@happier-dev/session-core/messages';
import { normalizeSessionId } from '@/sync/domains/session/normalizeSessionId';
import { useServerFeaturesSnapshotForServerId } from '@/sync/domains/features/featureDecisionRuntime';
import { usePreferredServerIdForSession } from '@/sync/runtime/orchestration/serverScopedRpc/usePreferredServerIdForSession';
import type { AgentInputHistoryScope, UserMessageHistoryNavigator } from './userMessageHistory';
import { DEFAULT_USER_MESSAGE_HISTORY_MAX_ENTRIES, collectUserMessageHistoryEntries, createUserMessageHistoryNavigator } from './userMessageHistory';
import { useUserMessageHistoryRemoteEntries, isSessionMessageRoleQuerySupported } from './useUserMessageHistoryEntries';
import type { SessionMessageHistoryRemoteRow } from '@/sync/engine/sessions/fetchUserMessageHistoryPage';
export { useUserMessageHistoryRemoteEntries, resetUserMessageHistoryRemoteEntriesForTests } from './useUserMessageHistoryEntries';
export type { UserMessageHistoryRemoteEntriesSnapshot } from './useUserMessageHistoryEntries';
const USER_MESSAGE_HISTORY_PREFETCH_REMAINING_ENTRIES = 3;

function mergeHistoryEntries(params: Readonly<{
    localEntries: ReadonlyArray<string>;
    remoteRows: ReadonlyArray<SessionMessageHistoryRemoteRow>;
    maxEntries: number;
}>): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const push = (value: string) => {
        if (!value.trim() || seen.has(value)) return;
        seen.add(value);
        out.push(value);
    };

    for (const entry of params.localEntries) {
        push(entry);
        if (out.length >= params.maxEntries) return out;
    }

    // Remote rows arrive newest-first from `fetchUserMessageHistoryPage` and pages accumulate
    // strictly older, so appending them in array order keeps ArrowUp walking backwards in time.
    for (const row of params.remoteRows) {
        // Composer history replays prompts; agent rows share the page but never the input.
        if (row.role !== 'user') continue;
        push(row.text);
        if (out.length >= params.maxEntries) return out;
    }

    return out;
}

export function useUserMessageHistory(opts: {
    scope: AgentInputHistoryScope;
    sessionId: string | null;
    serverId?: string | null;
    maxEntries?: number;
}): UserMessageHistoryNavigator {
    const normalizedSessionIdRaw = normalizeSessionId(opts.sessionId);
    const normalizedSessionId = normalizedSessionIdRaw.length > 0 ? normalizedSessionIdRaw : null;
    // Safe: for null sessionId, subscribe to a non-existent key and get empty arrays.
    const sessionIdForHook = normalizedSessionId ?? '__none__';
    const history = useSessionUserMessageHistory(opts.scope === 'perSession' ? sessionIdForHook : null);
    const preferredServerId = usePreferredServerIdForSession({
        serverId: opts.serverId,
        sessionId: sessionIdForHook,
    });
    const serverFeaturesSnapshot = useServerFeaturesSnapshotForServerId(preferredServerId, {
        enabled: opts.scope === 'perSession' && Boolean(normalizedSessionId && preferredServerId),
    });
    const roleQuerySupported = serverFeaturesSnapshot.status === 'ready'
        && isSessionMessageRoleQuerySupported(serverFeaturesSnapshot.features);
    const remoteHistoryState = useUserMessageHistoryRemoteEntries({
        enabled: opts.scope === 'perSession',
        initialBeforeSeq: null,
        sessionId: normalizedSessionId,
        serverId: opts.serverId,
    });
    const remoteHistoryRowsLengthRef = React.useRef(remoteHistoryState.rows.length);
    const remoteHistoryRequestNextPageRef = React.useRef(remoteHistoryState.requestNextPage);
    const localEntriesRef = React.useRef<ReadonlyArray<string>>([]);
    const combinedEntriesRef = React.useRef<ReadonlyArray<string>>([]);
    const requestContextRef = React.useRef<Readonly<{
        scope: AgentInputHistoryScope;
        sessionId: string | null;
        roleQuerySupported: boolean;
    }>>({
        scope: opts.scope,
        sessionId: normalizedSessionId,
        roleQuerySupported: false,
    });

    const localEntries = React.useMemo(() => {
        const messagesBySessionId = Object.fromEntries(Object.entries(history)
            .map(([id, rows]) => [id, Object.values(rows).sort(compareTranscriptMessagesOldestFirst)]));

        return collectUserMessageHistoryEntries({
            scope: opts.scope,
            sessionId: normalizedSessionId,
            messagesBySessionId,
            maxEntries: opts.maxEntries,
        });
    }, [opts.scope, normalizedSessionId, opts.maxEntries, history]);

    const entries = React.useMemo(() => mergeHistoryEntries({
        localEntries,
        remoteRows: opts.scope === 'perSession' ? remoteHistoryState.rows : [],
        maxEntries: opts.maxEntries ?? DEFAULT_USER_MESSAGE_HISTORY_MAX_ENTRIES,
    }), [localEntries, opts.maxEntries, opts.scope, remoteHistoryState.rows]);

    localEntriesRef.current = localEntries;
    combinedEntriesRef.current = entries;
    remoteHistoryRowsLengthRef.current = remoteHistoryState.rows.length;
    remoteHistoryRequestNextPageRef.current = remoteHistoryState.requestNextPage;
    requestContextRef.current = {
        scope: opts.scope,
        sessionId: normalizedSessionId,
        roleQuerySupported,
    };

    const requestRemoteHistoryPage = React.useCallback((retryFailed = false) => {
        const requestContext = requestContextRef.current;
        if (requestContext.scope !== 'perSession') return;
        if (!requestContext.sessionId || requestContext.roleQuerySupported !== true) return;
        remoteHistoryRequestNextPageRef.current(retryFailed);
    }, []);

    const warmup = React.useCallback((retryFailed = false) => {
        if (localEntriesRef.current.length > 0) return;
        if (remoteHistoryRowsLengthRef.current > 0) return;
        requestRemoteHistoryPage(retryFailed);
    }, [requestRemoteHistoryPage]);

    const maybePrefetchOlder = React.useCallback((state: { index: number; entriesLength: number }) => {
        if (state.entriesLength <= 0) return;
        if (state.index < Math.max(0, state.entriesLength - USER_MESSAGE_HISTORY_PREFETCH_REMAINING_ENTRIES)) return;
        requestRemoteHistoryPage(true);
    }, [requestRemoteHistoryPage]);

    const navigator = React.useMemo(
        () => createUserMessageHistoryNavigator(
            () => combinedEntriesRef.current,
            {
                onMoveUp: maybePrefetchOlder,
                onWarmup: warmup,
            },
        ),
        [maybePrefetchOlder, warmup],
    );

    React.useEffect(() => {
        // If the user switches sessions or scope, drop any in-progress history browsing state.
        navigator.reset();
    }, [navigator, normalizedSessionId, opts.scope]);

    return navigator;
}
