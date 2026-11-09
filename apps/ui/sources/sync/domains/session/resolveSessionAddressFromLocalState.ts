import { normalizeSessionAddress, type SessionAddress } from './sessionAddress';
import type { SessionListQueryHomeState } from './listing/sessionListQueryController';

export type SessionAddressLookupQueryState = Pick<
    SessionListQueryHomeState,
    'requestedQueryKey' | 'appliedQueryKey' | 'addresses' | 'phase'
>;

export type SessionAddressLookupState = Readonly<{
    sessions?: Readonly<Record<string, { serverId?: unknown } | null>> | null;
    sessionListIndexByServerId?: Readonly<Record<string, readonly unknown[] | null | undefined>> | null;
    sessionListRowsByServerId?: Readonly<Record<string, Readonly<Record<string, unknown>> | undefined>> | null;
    ordinarySessionListMembershipByServerId?: Readonly<Record<string, readonly string[] | undefined>> | null;
}>;

/** The membership a query state lends to address lookup: only an applied, ready answer to its current request. */
export function readSessionAddressLookupQueryMembership(queryState: SessionAddressLookupQueryState): readonly SessionAddress[] | null {
    return queryState.phase === 'ready' && queryState.appliedQueryKey !== null
        && queryState.appliedQueryKey === queryState.requestedQueryKey ? queryState.addresses : null;
}

/** Known local addresses only. This never probes Homes or treats cache presence as access. */
export function listSessionAddressesForSessionIdFromLocalState(
    state: SessionAddressLookupState | null | undefined,
    sessionId: string,
    options?: Readonly<{ queryStates?: readonly SessionAddressLookupQueryState[] }>,
): readonly SessionAddress[] {
    const sid = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!sid) return [];
    const candidates = new Map<string, SessionAddress>();
    const add = (serverId: unknown) => {
        const address = normalizeSessionAddress(serverId, sid);
        if (address) candidates.set(address.serverId, address);
    };

    const activeSession = state?.sessions?.[sid];
    if (activeSession) add(activeSession.serverId);
    for (const [serverId, membership] of Object.entries(state?.ordinarySessionListMembershipByServerId ?? {})) {
        if (membership?.some((member) => member.trim() === sid)) add(serverId);
    }
    for (const queryState of options?.queryStates ?? []) {
        for (const candidate of readSessionAddressLookupQueryMembership(queryState) ?? []) {
            const address = normalizeSessionAddress(candidate.serverId, candidate.sessionId);
            if (address?.sessionId === sid) add(address.serverId);
        }
    }
    return [...candidates.values()];
}

/** Legacy bare-id admission: active entity and current list memberships participate; focus is never a tie-breaker. */
export function resolveSessionAddressFromLocalState(
    state: SessionAddressLookupState | null | undefined,
    sessionId: string,
    options?: Readonly<{ queryStates?: readonly SessionAddressLookupQueryState[] }>,
): SessionAddress | null {
    const candidates = listSessionAddressesForSessionIdFromLocalState(state, sessionId, options);
    return candidates.length === 1 ? candidates[0] : null;
}

export function resolveServerIdForSessionIdFromLocalState(
    state: SessionAddressLookupState | null | undefined,
    sessionId: string,
): string | null {
    return resolveSessionAddressFromLocalState(state, sessionId)?.serverId ?? null;
}
