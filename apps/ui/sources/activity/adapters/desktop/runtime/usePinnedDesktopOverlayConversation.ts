import * as React from 'react';
import { useShallow } from 'zustand/react/shallow';
import { storage } from '@/sync/domains/state/storage';
import { registerSessionRealtimeTranscriptConsumer } from '@/sync/runtime/sessionRealtimeTranscriptConsumers';
import { getSyncSingleton } from '@/sync/runtime/getSyncSingleton';
import { readStoredSessionTranscriptForAddress } from '@/sync/domains/messages/readStoredSessionMessagesForAddress';
import { runWithServerRequestAuthorityForServerAccountScope } from '@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope';
import { runWithServerAccountScopeRequestGuard } from '@/sync/runtime/orchestration/serverScopedRpc/serverAccountScopeRequestGuard';
import { readLatestActivityAgentReply } from '@/activity/attention/readLatestActivityAgentReply';
import type { PinnedDesktopOverlayConversation } from '../presentation/notchBotTypes';

/** One mounted pin owns one transcript demand; other Sessions never enter this selector. */
export function usePinnedDesktopOverlayConversation(params: Readonly<{
    target: Pick<PinnedDesktopOverlayConversation, 'serverId' | 'accountId' | 'sessionId'>;
    hidden: boolean;
    reachable: boolean;
}>): PinnedDesktopOverlayConversation {
    const { serverId, accountId, sessionId } = params.target;
    const selected = storage(useShallow(state => {
        const transcript = readStoredSessionTranscriptForAddress(state, params.target) ?? undefined;
        return { loaded: transcript?.isLoaded === true,
            text: params.hidden ? null : readLatestActivityAgentReply(transcript) };
    }), { sessions: [sessionId], sessionMessages: [sessionId] });
    const [load, setLoad] = React.useState(() => ({ serverId, accountId, sessionId, inFlight: !selected.loaded }));
    React.useEffect(() => {
        const release = registerSessionRealtimeTranscriptConsumer(sessionId, serverId);
        let current = true;
        const scope = { serverId, accountId };
        if (!readStoredSessionTranscriptForAddress(storage.getState(), { serverId, sessionId })?.isLoaded) {
            setLoad({ serverId, accountId, sessionId, inFlight: true });
            void runWithServerAccountScopeRequestGuard({ scope, isCurrent: () => current,
                staleError: () => new Error('Pinned conversation Account retired'),
            }, guard => runWithServerRequestAuthorityForServerAccountScope({ scope,
                activeRequest: async () => { throw new Error('Pinned conversation requires captured Account authority'); },
            }, async authority => {
                const sync = getSyncSingleton();
                const result = await sync.ensureSessionVisibleForMessageRoute(sessionId, {
                    serverId, authority, scopeCurrentness: guard.isCurrent, signal: guard.signal,
                    forceRefresh: true, hydrateMessages: false,
                });
                if (result.kind === 'available' && guard.isCurrent()) await sync.refreshSessionMessages(sessionId, {
                    authority, scopeCurrentness: guard.isCurrent,
                });
            })).finally(() => {
                if (current) setLoad({ serverId, accountId, sessionId, inFlight: false });
            }).catch(() => { /* Keep unavailable exact-scope content loading; reopening retries the load. */ });
        }
        return () => { current = false; release(); };
    }, [serverId, accountId, sessionId]);
    const refreshing = load.serverId === serverId && load.accountId === accountId && load.sessionId === sessionId ? load.inFlight : !selected.loaded;
    return React.useMemo(() => ({ serverId, accountId, sessionId, reachable: params.reachable, refreshing,
        reply: params.hidden ? { state: 'hidden', text: null }
            : !selected.loaded ? { state: 'loading', text: null }
                : selected.text ? { state: 'ready', text: selected.text } : { state: 'none', text: null },
    }), [serverId, accountId, sessionId, params.reachable, params.hidden, refreshing, selected.loaded, selected.text]);
}
