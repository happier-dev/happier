import * as React from 'react';

import { readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';
import type { MemorySearchHitV1 } from '@happier-dev/protocol/memory/memorySearch';

import {
    captureMemorySearchSessionReadAuthority,
    authorizeMemorySearchResult,
    readMemorySearchSessionHydrationConcurrencyLimit,
    readMemorySearchSessionForServerScope,
} from '@/sync/domains/memory/hydrateMemorySearchSessionTargets';
import { normalizeMemorySearchSessionId } from '@/sync/domains/memory/applyMemorySearchSessionEligibility';
import { searchDaemonMemory } from '@/sync/domains/memory/searchDaemonMemory';
import { SESSION_MACHINE_TARGET_UNAVAILABLE_ERROR_CODE } from '@/sync/runtime/sessionMachineRpcErrorCodes';
import { searchHomeMemory } from '@/sync/domains/memory/searchHomeMemory';
import {
    useMemorySearchProvider,
    type MemorySearchProvider,
} from '@/sync/domains/memory/useMemorySearchProvider';
import type { ServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { useServerCredentialAccountScopes } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { serverAccountScopeKeySuffix } from '@/sync/domains/scope/serverAccountScope';

import { sessionTagKey } from '../sessionTagUtils';

export const SESSION_LIST_MEMORY_SEARCH_DEBOUNCE_MS = 300;
export const SESSION_LIST_MEMORY_SEARCH_MIN_QUERY_LENGTH = 2;
const SESSION_LIST_MEMORY_SEARCH_MAX_RESULTS = 50;

const EMPTY_MEMORY_MATCHED_SESSION_KEYS: ReadonlySet<string> = Object.freeze(new Set<string>());
const EMPTY_MEMORY_MATCHED_SESSION_TARGETS: ReadonlyArray<SessionListMemorySearchTarget> = Object.freeze([]);

/**
 * Exact facts the activation and materialization owners need for one transcript hit.
 * The request target is captured here so a focus change during the query cannot
 * re-key a result under another server.
 */
export type SessionListMemorySearchTarget = Readonly<{
    sessionKey: string;
    serverId: string;
    accountId: string;
    sessionId: string;
    reasons: readonly ['transcript'];
    /** Exact daemon source captured at query time; Home search has no machine source. */
    sourceMachineId: string | null;
}>;

export type SessionListMemorySearchAugmentationState = Readonly<{
    memoryMatchedSessionKeys: ReadonlySet<string>;
    /** Provider order is preserved; transcript relevance is never re-sorted against metadata. */
    memoryMatchedSessionTargets: ReadonlyArray<SessionListMemorySearchTarget>;
    isSearchingMemory: boolean;
    memorySearchUnavailableReason?: string;
    lastSuccessfulQuery?: string;
    lastSuccessfulScopeKey?: string;
    activeScopeKey: string;
}>;

const IDLE_MEMORY_SEARCH_STATE: SessionListMemorySearchAugmentationState = {
    memoryMatchedSessionKeys: EMPTY_MEMORY_MATCHED_SESSION_KEYS,
    memoryMatchedSessionTargets: EMPTY_MEMORY_MATCHED_SESSION_TARGETS,
    isSearchingMemory: false,
    activeScopeKey: '',
};

function encodeScopePart(value: string | null | undefined): string {
    const normalized = String(value ?? '').trim();
    return `${normalized.length}:${normalized}`;
}

export function buildSessionListMemorySearchScopeKey(input: Readonly<{
    accountScope: Readonly<{ serverId: string; accountId: string }> | null;
    provider: 'home' | 'daemon' | null;
    serverId: string;
    machineId: string | null;
    credentialRevision?: number;
}>): string {
    return [
        `account:${input.accountScope ? serverAccountScopeKeySuffix(input.accountScope) : 'none'}`,
        `provider:${encodeScopePart(input.provider)}`,
        `server:${encodeScopePart(input.serverId)}`,
        `machine:${encodeScopePart(input.provider === 'daemon' ? input.machineId : null)}`,
        `credential:${input.credentialRevision ?? -1}`,
    ].join('|');
}

export type SessionListMemorySearchContext = Readonly<{
    providerDecision: MemorySearchProvider;
    isHomeProvider: boolean;
    serverId: string;
    machineId: string | null;
    activeScopeKey: string;
    accountBinding: ServerCredentialAccountScopeBinding | null;
}>;

export function useSessionListMemorySearchContext(
    target?: Readonly<{ serverId?: string | null }>,
    input?: Pick<SessionListMemorySearchAugmentationInput, 'enabled' | 'searchQuery'>,
): SessionListMemorySearchContext {
    const enabled = input?.enabled !== false
        && (input === undefined || input.searchQuery.trim().length >= SESSION_LIST_MEMORY_SEARCH_MIN_QUERY_LENGTH);
    const requestedServerId = String(target?.serverId ?? '').trim();
    const providerDecision = useMemorySearchProvider(target === undefined
        ? { kind: 'ambient' }
        : requestedServerId
            ? { kind: 'exact', serverId: requestedServerId }
            : { kind: 'none' }, { enabled });
    const isHomeProvider = providerDecision.provider === 'home';
    const machineId = providerDecision.daemonTarget?.machineId ?? null;
    const serverId = isHomeProvider
        ? providerDecision.homeServerId ?? ''
        : providerDecision.daemonTarget?.serverId ?? '';
    const accountServerId = requestedServerId || serverId;
    const credentialBindings = useServerCredentialAccountScopes([accountServerId]);
    const accountBinding = accountServerId ? credentialBindings.get(accountServerId) ?? null : null;
    const accountScope = accountBinding
        ? { serverId: accountServerId, accountId: accountBinding.accountId }
        : null;
    const activeScopeKey = buildSessionListMemorySearchScopeKey({
        accountScope,
        provider: providerDecision.provider,
        serverId,
        machineId,
        credentialRevision: accountBinding?.revision,
    });
    return React.useMemo(() => ({
        providerDecision,
        isHomeProvider,
        serverId,
        machineId,
        activeScopeKey,
        accountBinding,
    }), [accountBinding, activeScopeKey, isHomeProvider, machineId, providerDecision, serverId]);
}

function isAbortSupersession(error: unknown, signal: AbortSignal): boolean {
    return signal.aborted || (error instanceof Error && error.name === 'AbortError');
}

function resolveMemorySearchFailureReason(error: unknown): string {
    // Keep the transport's canonical target-unavailable code intact at the
    // boundary, while projecting it into the contextual Search UI's local
    // availability vocabulary. Disabled search and an unreachable daemon are
    // materially different states and must not share the disabled copy.
    const code = typeof error === 'string' ? error : readRpcErrorCode(error);
    if (code === SESSION_MACHINE_TARGET_UNAVAILABLE_ERROR_CODE) {
        return 'daemon_unavailable';
    }
    return 'rpc_error';
}

function resolveIdleMemorySearchState(
    current: SessionListMemorySearchAugmentationState,
    activeScopeKey: string,
    memorySearchUnavailableReason?: string,
): SessionListMemorySearchAugmentationState {
    const hasMemoryMatches = current.memoryMatchedSessionKeys.size > 0;
    if (
        !hasMemoryMatches
        && current.activeScopeKey === activeScopeKey
        && current.isSearchingMemory === false
        && current.memorySearchUnavailableReason === memorySearchUnavailableReason
        && current.lastSuccessfulQuery === undefined
        && current.lastSuccessfulScopeKey === undefined
    ) {
        return current;
    }
    return {
        memoryMatchedSessionKeys: EMPTY_MEMORY_MATCHED_SESSION_KEYS,
        memoryMatchedSessionTargets: EMPTY_MEMORY_MATCHED_SESSION_TARGETS,
        isSearchingMemory: false,
        memorySearchUnavailableReason,
        activeScopeKey,
    };
}

function resolveRefreshingMemorySearchState(
    current: SessionListMemorySearchAugmentationState,
    normalizedQuery: string,
    activeScopeKey: string,
): SessionListMemorySearchAugmentationState {
    if (current.lastSuccessfulQuery === normalizedQuery && current.lastSuccessfulScopeKey === activeScopeKey) {
        if (!current.isSearchingMemory && current.memorySearchUnavailableReason === undefined) {
            return current;
        }
        return {
            ...current,
            isSearchingMemory: false,
            memorySearchUnavailableReason: undefined,
        };
    }
    return resolveIdleMemorySearchState(current, activeScopeKey);
}

/**
 * Session-list consumption of the explicit Home/daemon transcript request adapters.
 *
 * The provider decision, its exact target, and its truthful unavailable state come
 * from the one shared decision seam; this hook owns only the query lifecycle. Each
 * issued query gets exactly one `AbortController`: a query, target, server, or
 * unmount change aborts it, and that abort is supersession rather than an error.
 *
 * Every valid hit is published. A hit is never discarded because its session is not
 * already rendered in the current view — each absent identity is materialized
 * through the canonical explicit-server session reader, and the session list renders
 * the result as an `Other matches` row.
 */
type SessionListMemorySearchAugmentationInput = Readonly<{
    searchQuery: string;
    enabled?: boolean;
    /** Optional contextual Session corpus, applied by Home/daemon before limiting. */
    eligibleSessionIds?: readonly string[];
}>;

export function useSessionListMemorySearchAugmentationForContext(
    input: SessionListMemorySearchAugmentationInput,
    context: SessionListMemorySearchContext,
): SessionListMemorySearchAugmentationState {
    const { accountBinding, activeScopeKey, isHomeProvider, machineId, providerDecision, serverId } = context;
    const queryAvailable = providerDecision.queryAvailable;
    const unavailableReason = providerDecision.unavailableReason;
    const normalizedQuery = input.searchQuery.trim();
    const [state, setState] = React.useState<SessionListMemorySearchAugmentationState>(IDLE_MEMORY_SEARCH_STATE);
    const activeScopeKeyRef = React.useRef(activeScopeKey);
    activeScopeKeyRef.current = activeScopeKey;

    React.useEffect(() => {
        if (
            input.enabled === false
            || providerDecision.provider === null
            || normalizedQuery.length < SESSION_LIST_MEMORY_SEARCH_MIN_QUERY_LENGTH
        ) {
            setState((current) => resolveIdleMemorySearchState(current, activeScopeKey));
            return;
        }

        // The decision seam already knows whether this context may issue a request
        // and why it may not; the truthful reason is surfaced rather than an empty
        // result.
        if (!queryAvailable || !serverId || (!isHomeProvider && !machineId)) {
            setState((current) => resolveIdleMemorySearchState(current, activeScopeKey, unavailableReason ?? undefined));
            return;
        }

        const controller = new AbortController();
        const signal = controller.signal;
        if (!accountBinding || !accountBinding.isCurrent()) {
            setState((current) => resolveIdleMemorySearchState(current, activeScopeKey));
            return;
        }
        const retirement = accountBinding.onRetire(() => controller.abort());
        const isCurrentRequest = () => (
            !signal.aborted
            && accountBinding.isCurrent()
            && activeScopeKeyRef.current === activeScopeKey
        );

        const applySearchHits = async (
            hits: ReadonlyArray<MemorySearchHitV1>,
            authority: Awaited<ReturnType<typeof captureMemorySearchSessionReadAuthority>>,
        ) => {
            // Both indexes are derived state that can outlive the Account's access
            // or its caller-visible transcript ceiling. Reauthorize every retained
            // range through the exact-server Session reader before it becomes a row.
            const authorizedResult = await authorizeMemorySearchResult({
                result: { v: 1, ok: true, hits: [...hits] },
                serverId,
                accountId: accountBinding.accountId,
                authority,
                accountLifetime: accountBinding,
                readSessionForServerScope: readMemorySearchSessionForServerScope,
                concurrencyLimit: readMemorySearchSessionHydrationConcurrencyLimit(),
                signal,
            });
            if (!isCurrentRequest()) return;
            if (authorizedResult.ok !== true) return;

            const seenKeys = new Set<string>();
            const hitTargets: SessionListMemorySearchTarget[] = [];
            for (const hit of authorizedResult.hits) {
                const sessionId = normalizeMemorySearchSessionId(hit.sessionId);
                if (!sessionId) continue;
                const sessionKey = sessionTagKey(serverId, sessionId);
                if (seenKeys.has(sessionKey)) continue;
                seenKeys.add(sessionKey);
                hitTargets.push({
                    sessionKey,
                    serverId,
                    accountId: accountBinding.accountId,
                    sessionId,
                    reasons: ['transcript'],
                    sourceMachineId: isHomeProvider ? null : machineId,
                });
            }

            const nextTargets = hitTargets;

            const nextKeys = new Set(nextTargets.map((target) => target.sessionKey));
            if (!isCurrentRequest()) return;
            setState({
                memoryMatchedSessionKeys: nextKeys.size > 0 ? nextKeys : EMPTY_MEMORY_MATCHED_SESSION_KEYS,
                memoryMatchedSessionTargets: nextTargets.length > 0 ? nextTargets : EMPTY_MEMORY_MATCHED_SESSION_TARGETS,
                isSearchingMemory: false,
                lastSuccessfulQuery: normalizedQuery,
                lastSuccessfulScopeKey: activeScopeKey,
                activeScopeKey,
            });
        };

        setState((current) => resolveRefreshingMemorySearchState(current, normalizedQuery, activeScopeKey));

        const timeout = setTimeout(() => {
            void (async () => {
                let authority: Awaited<ReturnType<typeof captureMemorySearchSessionReadAuthority>> | null = null;
                try {
                    if (!isCurrentRequest()) return;
                    authority = await captureMemorySearchSessionReadAuthority({
                        serverId,
                        accountId: accountBinding.accountId,
                    });
                    if (!isCurrentRequest()) return;
                    setState((current) => ({
                        ...current,
                        activeScopeKey,
                        isSearchingMemory: true,
                        memorySearchUnavailableReason: undefined,
                    }));

                    if (isHomeProvider) {
                        // Home search never requires a machine or a running daemon.
                        const homeResult = await searchHomeMemory({
                            serverId,
                            accountId: accountBinding.accountId,
                            query: normalizedQuery,
                            scope: { type: 'global' },
                            mode: 'auto',
                            ...(input.eligibleSessionIds !== undefined
                                ? { eligibleSessionIds: input.eligibleSessionIds }
                                : {}),
                            maxResults: SESSION_LIST_MEMORY_SEARCH_MAX_RESULTS,
                            signal,
                        });
                        if (!isCurrentRequest()) return;
                        if (!homeResult.ok) {
                            setState((current) => resolveIdleMemorySearchState(
                                current,
                                activeScopeKey,
                                resolveMemorySearchFailureReason(homeResult.errorCode),
                            ));
                            return;
                        }
                        await applySearchHits(homeResult.hits, authority);
                        return;
                    }

                    const result = await searchDaemonMemory({
                        serverId,
                        accountId: accountBinding.accountId,
                        machineId,
                        query: normalizedQuery,
                        scope: { type: 'global' },
                        mode: 'auto',
                        ...(input.eligibleSessionIds !== undefined
                            ? { eligibleSessionIds: input.eligibleSessionIds }
                            : {}),
                        maxResults: SESSION_LIST_MEMORY_SEARCH_MAX_RESULTS,
                        signal,
                    });
                    if (!isCurrentRequest()) return;

                    if (!result.ok) {
                        setState((current) => resolveIdleMemorySearchState(
                            current,
                            activeScopeKey,
                            resolveMemorySearchFailureReason(result.errorCode),
                        ));
                        return;
                    }

                    await applySearchHits(result.hits, authority);
                } catch (error) {
                    // A superseded query owns no state: the query that replaced it does.
                    if (isAbortSupersession(error, signal) || !isCurrentRequest()) return;
                    setState((current) => resolveIdleMemorySearchState(
                        current,
                        activeScopeKey,
                        resolveMemorySearchFailureReason(error),
                    ));
                } finally {
                    await authority?.release();
                }
            })();
        }, SESSION_LIST_MEMORY_SEARCH_DEBOUNCE_MS);

        return () => {
            retirement.dispose();
            clearTimeout(timeout);
            controller.abort();
        };
    }, [
        activeScopeKey,
        accountBinding,
        input.enabled,
        input.eligibleSessionIds,
        isHomeProvider,
        machineId,
        providerDecision.provider,
        normalizedQuery,
        queryAvailable,
        serverId,
        unavailableReason,
    ]);

    if (state.activeScopeKey !== activeScopeKey) {
        return { ...IDLE_MEMORY_SEARCH_STATE, activeScopeKey };
    }
    return state;
}

export function useSessionListMemorySearchAugmentation(
    input: SessionListMemorySearchAugmentationInput,
): SessionListMemorySearchAugmentationState {
    return useSessionListMemorySearchAugmentationForContext(
        input,
        useSessionListMemorySearchContext(undefined, input),
    );
}
