import * as React from 'react';
import { parseSearchQuery } from '@happier-dev/protocol';

import type { SessionListViewItem } from '@/sync/domains/state/storage';
import { getActiveServerSnapshot, subscribeActiveServer } from '@/sync/domains/server/serverRuntime';
import { resolveServerScopedSessionContext } from '@/sync/runtime/orchestration/serverScopedRpc/resolveServerScopedSessionContext';
import { searchSessionTranscript, type SessionTranscriptSearchResult } from '@/sync/ops/sessionTranscriptSearch';
import { createSessionSearchMatcher } from '@/sync/domains/session/searchQuery';

import { buildSessionSearchText } from '../sessionListFilters';
import { sessionTagKey } from '../sessionTagUtils';

const EMPTY_KEYS: ReadonlySet<string> = new Set();
const DEBOUNCE_MS = 300;

type SearchState = Readonly<{
    query: string;
    generation: number;
    transcriptMatchedSessionKeys: ReadonlySet<string>;
    transcriptExcludedSessionKeys: ReadonlySet<string>;
    isSearching: boolean;
    hasError: boolean;
}>;
const IDLE: SearchState = {
    query: '', generation: -1, transcriptMatchedSessionKeys: EMPTY_KEYS,
    transcriptExcludedSessionKeys: EMPTY_KEYS, isSearching: false, hasError: false,
};
const subscribeServer = (notify: () => void) => subscribeActiveServer(notify);
const subscribeIdle = () => () => {};
const readGeneration = () => getActiveServerSnapshot().generation;

export function useSessionListTranscriptSearch(input: Readonly<{
    searchQuery: string;
    items: ReadonlyArray<SessionListViewItem>;
    searchableTextBySessionKey: Readonly<Record<string, string>>;
    enabled: boolean;
    loadHistory?: (signal: AbortSignal) => Promise<void>;
}>) {
    const query = input.searchQuery.trim();
    const searchDemanded = input.enabled && query.length > 0;
    const generation = React.useSyncExternalStore(searchDemanded ? subscribeServer : subscribeIdle, readGeneration, readGeneration);
    const parsedQuery = React.useMemo(() => parseSearchQuery(query), [query]);
    const [retryRevision, setRetryRevision] = React.useState(0);
    const retry = React.useCallback(() => setRetryRevision((revision) => revision + 1), []);
    const [state, setState] = React.useState<SearchState>(IDLE);
    const [historyState, setHistoryState] = React.useState({ query: '', generation: -1, pending: false, error: false });
    // Keep only query-specific verdicts, never a second decrypted transcript cache.
    const settled = React.useRef({ query, generation, results: new Map<string, {
        signature: string; result: SessionTranscriptSearchResult;
    }>() });
    const candidates = React.useMemo(() => {
        if (!input.enabled || !query) return [];
        const byKey = new Map<string, {
            key: string; serverId: string; sessionId: string; initialText: string; signature: string;
        }>();
        for (const item of input.items) {
            if (item.type !== 'session' || !item.serverId) continue;
            // Direct transcripts belong to their provider; retain their existing loaded-text search.
            if (item.session.metadata?.directSessionV1) continue;
            const key = sessionTagKey(item.serverId, item.session.id);
            const initialText = buildSessionSearchText(item, key, input.searchableTextBySessionKey);
            const initialMatch = createSessionSearchMatcher(parsedQuery, initialText);
            byKey.set(key, {
                key, serverId: item.serverId, sessionId: item.session.id, initialText,
                // Cache query verdicts without copying decrypted message text into cache keys.
                signature: JSON.stringify([item.session.seq, initialMatch.excluded, initialMatch.remainingTerms]),
            });
        }
        return [...byKey.values()];
    }, [input.enabled, input.items, input.searchableTextBySessionKey, parsedQuery, query]);
    const signature = JSON.stringify(candidates.map(({ key, signature }) => [key, signature]));
    const candidatesRef = React.useRef(candidates);
    candidatesRef.current = candidates;

    React.useEffect(() => {
        const loadHistory = input.loadHistory;
        if (!input.enabled || !query || !loadHistory) return;
        const controller = new AbortController();
        setHistoryState({ query, generation, pending: true, error: false });
        const timeout = setTimeout(() => {
            void loadHistory(controller.signal).then(() => {
                if (!controller.signal.aborted) setHistoryState({ query, generation, pending: false, error: false });
            }, () => {
                if (!controller.signal.aborted) setHistoryState({ query, generation, pending: false, error: true });
            });
        }, DEBOUNCE_MS);
        return () => { clearTimeout(timeout); controller.abort(); };
    }, [generation, input.enabled, input.loadHistory, query, retryRevision]);

    React.useEffect(() => {
        if (!input.enabled || !query || signature === '[]') {
            setState((current) => current === IDLE ? current : IDLE);
            return;
        }
        const controller = new AbortController();
        if (settled.current.query !== query || settled.current.generation !== generation) {
            settled.current = { query, generation, results: new Map() };
        }
        const cache = settled.current.results;
        const matched = new Set<string>();
        const excluded = new Set<string>();
        let hasError = false;
        const publish = (isSearching: boolean) => {
            if (controller.signal.aborted) return;
            setState((current) => {
                if (controller.signal.aborted) return current;
                if (current.query === query && current.generation === generation
                    && current.isSearching === isSearching && current.hasError === hasError
                    && current.transcriptMatchedSessionKeys.size === matched.size
                    && [...matched].every((key) => current.transcriptMatchedSessionKeys.has(key))
                    && current.transcriptExcludedSessionKeys.size === excluded.size
                    && [...excluded].every((key) => current.transcriptExcludedSessionKeys.has(key))) return current;
                return {
                    query, generation, isSearching, hasError,
                    transcriptMatchedSessionKeys: new Set(matched),
                    transcriptExcludedSessionKeys: new Set(excluded),
                };
            });
        };
        const addResult = (key: string, result: SessionTranscriptSearchResult) => {
            if (result.matched) matched.add(key);
            if (result.excluded) excluded.add(key);
        };
        const pending = candidatesRef.current.filter((candidate) => {
            const previous = cache.get(candidate.key);
            if (previous?.signature !== candidate.signature) return true;
            addResult(candidate.key, previous.result);
            return false;
        });
        publish(pending.length > 0);
        const timeout = setTimeout(() => {
            void (async () => {
                const contexts = new Map<string, ReturnType<typeof resolveServerScopedSessionContext>>();
                // Serialize reads so a large history cannot flood the transcript API or decryptor.
                for (const candidate of pending) {
                    if (controller.signal.aborted) return;
                    try {
                        let contextPromise = contexts.get(candidate.serverId);
                        if (!contextPromise) {
                            contextPromise = resolveServerScopedSessionContext({ serverId: candidate.serverId, preferScoped: true });
                            contexts.set(candidate.serverId, contextPromise);
                        }
                        const context = await contextPromise;
                        if (controller.signal.aborted) return;
                        if (context.scope !== 'scoped') throw new Error('Missing scoped session context');
                        const result = await searchSessionTranscript({
                            context, sessionId: candidate.sessionId, query: parsedQuery,
                            initialText: candidate.initialText, signal: controller.signal,
                        });
                        if (controller.signal.aborted) return;
                        cache.set(candidate.key, { signature: candidate.signature, result });
                        addResult(candidate.key, result);
                        if (result.matched || result.excluded) publish(true);
                    } catch {
                        if (controller.signal.aborted) return;
                        hasError = true;
                    }
                }
                publish(false);
            })();
        }, DEBOUNCE_MS);
        return () => { clearTimeout(timeout); controller.abort(); };
    }, [generation, input.enabled, parsedQuery, query, retryRevision, signature]);

    const activeState = input.enabled && state.query === query && state.generation === generation ? state : IDLE;
    const historyActive = input.enabled && Boolean(input.loadHistory) && historyState.query === query && historyState.generation === generation;
    return {
        ...activeState,
        isSearching: activeState.isSearching || (historyActive && historyState.pending),
        hasError: activeState.hasError || (historyActive && historyState.error),
        retry,
    };
}
