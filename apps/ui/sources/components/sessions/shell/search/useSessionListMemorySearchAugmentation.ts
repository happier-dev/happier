import * as React from 'react';

import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { useFirstVisibleMachineId } from '@/sync/domains/state/storage';
import { fetchDaemonMemoryStatus } from '@/sync/domains/memory/fetchDaemonMemoryStatus';
import { isDaemonMemorySearchUsable } from '@/sync/domains/memory/isDaemonMemorySearchUsable';
import { searchDaemonMemory } from '@/sync/domains/memory/searchDaemonMemory';

import { sessionTagKey } from '../sessionTagUtils';

export const SESSION_LIST_MEMORY_SEARCH_DEBOUNCE_MS = 300;
export const SESSION_LIST_MEMORY_SEARCH_MIN_QUERY_LENGTH = 2;
const SESSION_LIST_MEMORY_SEARCH_MAX_RESULTS = 50;

const EMPTY_MEMORY_MATCHED_SESSION_KEYS: ReadonlySet<string> = Object.freeze(new Set<string>());

function resolveIdleMemorySearchState(
    current: SessionListMemorySearchAugmentationState,
    memorySearchUnavailableReason?: string,
): SessionListMemorySearchAugmentationState {
    const hasMemoryMatches = current.memoryMatchedSessionKeys.size > 0 || current.memoryExcludedSessionKeys.size > 0;
    if (
        !hasMemoryMatches
        && current.isSearchingMemory === false
        && current.memorySearchUnavailableReason === memorySearchUnavailableReason
    ) {
        return current;
    }
    return {
        ...current,
        memoryMatchedSessionKeys: EMPTY_MEMORY_MATCHED_SESSION_KEYS,
        memoryExcludedSessionKeys: EMPTY_MEMORY_MATCHED_SESSION_KEYS,
        isSearchingMemory: false,
        memorySearchUnavailableReason,
    };
}

function buildCandidateSignature(candidateSessionKeys: ReadonlySet<string>): string {
    if (candidateSessionKeys.size === 0) return '';
    return [...candidateSessionKeys].sort().join('\u0001');
}

function resolveRefreshingMemorySearchState(
    current: SessionListMemorySearchAugmentationState,
    normalizedQuery: string,
): SessionListMemorySearchAugmentationState {
    if (current.lastSuccessfulQuery === normalizedQuery) {
        if (!current.isSearchingMemory && current.memorySearchUnavailableReason === undefined) {
            return current;
        }
        return {
            ...current,
            isSearchingMemory: false,
            memorySearchUnavailableReason: undefined,
        };
    }
    return resolveIdleMemorySearchState(current);
}

export type SessionListMemorySearchAugmentationState = Readonly<{
    memoryMatchedSessionKeys: ReadonlySet<string>;
    memoryExcludedSessionKeys: ReadonlySet<string>;
    isSearchingMemory: boolean;
    memorySearchUnavailableReason?: string;
    lastSuccessfulQuery?: string;
}>;

export function useSessionListMemorySearchAugmentation(input: Readonly<{
    searchQuery: string;
    getCandidateSessionKeys: () => ReadonlySet<string>;
    enabled?: boolean;
}>): SessionListMemorySearchAugmentationState {
    const memorySearchEnabled = useFeatureEnabled('memory.search');
    const serverId = getActiveServerSnapshot().serverId;
    const normalizedQuery = input.searchQuery.trim();
    const searchDemanded = input.enabled !== false
        && memorySearchEnabled
        && normalizedQuery.length >= SESSION_LIST_MEMORY_SEARCH_MIN_QUERY_LENGTH
        && Boolean(serverId);
    const machineId = useFirstVisibleMachineId(searchDemanded);
    const candidateSessionKeys = React.useMemo(
        () => searchDemanded && machineId
            ? input.getCandidateSessionKeys()
            : EMPTY_MEMORY_MATCHED_SESSION_KEYS,
        [input.getCandidateSessionKeys, machineId, searchDemanded],
    );
    const candidateSignature = React.useMemo(
        () => buildCandidateSignature(candidateSessionKeys),
        [candidateSessionKeys],
    );
    const candidateSessionKeysRef = React.useRef(candidateSessionKeys);
    candidateSessionKeysRef.current = candidateSessionKeys;
    const requestIdRef = React.useRef(0);
    const [state, setState] = React.useState<SessionListMemorySearchAugmentationState>({
        memoryMatchedSessionKeys: EMPTY_MEMORY_MATCHED_SESSION_KEYS,
        memoryExcludedSessionKeys: EMPTY_MEMORY_MATCHED_SESSION_KEYS,
        isSearchingMemory: false,
    });

    React.useEffect(() => {
        const requestId = requestIdRef.current + 1;
        requestIdRef.current = requestId;
        const isCurrent = () => requestIdRef.current === requestId;

        if (
            input.enabled === false
            || !memorySearchEnabled
            || normalizedQuery.length < SESSION_LIST_MEMORY_SEARCH_MIN_QUERY_LENGTH
            || !serverId
            || !machineId
            || candidateSignature.length === 0
        ) {
            setState((current) => resolveIdleMemorySearchState(current));
            return;
        }

        setState((current) => resolveRefreshingMemorySearchState(current, normalizedQuery));

        const timeout = setTimeout(() => {
            void (async () => {
                try {
                    setState((current) => ({
                        ...current,
                        isSearchingMemory: true,
                        memorySearchUnavailableReason: undefined,
                    }));

                    const status = await fetchDaemonMemoryStatus({ serverId, machineId });
                    if (!isCurrent()) return;
                    if (!isDaemonMemorySearchUsable(status)) {
                        setState((current) => resolveIdleMemorySearchState(current, 'unusable'));
                        return;
                    }

                    const result = await searchDaemonMemory({
                        serverId,
                        machineId,
                        query: normalizedQuery,
                        scope: { type: 'global' },
                        mode: 'auto',
                        maxResults: SESSION_LIST_MEMORY_SEARCH_MAX_RESULTS,
                    });
                    if (!isCurrent()) return;

                    if (!result.ok) {
                        setState((current) => resolveIdleMemorySearchState(current, result.errorCode));
                        return;
                    }

                    const candidateSessionKeys = candidateSessionKeysRef.current;
                    const nextKeys = new Set<string>();
                    for (const hit of result.hits) {
                        const key = sessionTagKey(serverId, hit.sessionId);
                        if (candidateSessionKeys.has(key)) {
                            nextKeys.add(key);
                        }
                    }
                    setState({
                        memoryMatchedSessionKeys: nextKeys.size > 0 ? nextKeys : EMPTY_MEMORY_MATCHED_SESSION_KEYS,
                        memoryExcludedSessionKeys: new Set(
                            (result.excludedSessionIds ?? [])
                                .map((sessionId) => sessionTagKey(serverId, sessionId))
                                .filter((key) => candidateSessionKeys.has(key)),
                        ),
                        isSearchingMemory: false,
                        lastSuccessfulQuery: normalizedQuery,
                    });
                } catch {
                    if (!isCurrent()) return;
                    setState((current) => resolveIdleMemorySearchState(current, 'rpc_error'));
                }
            })();
        }, SESSION_LIST_MEMORY_SEARCH_DEBOUNCE_MS);

        return () => {
            clearTimeout(timeout);
        };
    }, [
        candidateSignature,
        input.enabled,
        machineId,
        memorySearchEnabled,
        normalizedQuery,
        serverId,
    ]);

    return state;
}
