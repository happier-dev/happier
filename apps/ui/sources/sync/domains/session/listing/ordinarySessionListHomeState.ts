import type { OrdinarySessionListFrontier } from '@/sync/engine/sessions/ordinarySessionListFrontier';
import { normalizeSessionAddress, type SessionAddress } from '@/sync/domains/session/sessionAddress';

import type { SessionListQueryHomeState } from './sessionListQueryController';
import type { SessionListHomeObservation } from './sessionListHomeObservation';

/**
 * The active Home's ordinary Session-list lifecycle, as its single owner reports it.
 *
 * Sync owns this corpus: its bootstrap/reconnect replace, its append continuation and
 * its cursors are the only ones for `/v2/sessions` on the applied Home.
 */
export type OrdinarySessionListLifecycle = Readonly<{
    serverId: string | null;
    hasFetchedSnapshot: boolean;
    fetchInFlight: boolean;
    fetchMoreInFlight: boolean;
    frontier: OrdinarySessionListFrontier;
}>;

function buildAddresses(serverId: string, sessionIds: readonly string[]): readonly SessionAddress[] {
    const addresses: SessionAddress[] = [];
    const seen = new Set<string>();
    for (const sessionId of sessionIds) {
        const address = normalizeSessionAddress(serverId, sessionId);
        if (!address || seen.has(address.sessionId)) continue;
        seen.add(address.sessionId);
        addresses.push(address);
    }
    return addresses;
}

/**
 * Projects Sync's ordinary list lifecycle onto the per-Home query state the Sessions
 * surface reads.
 *
 * This is a read, not a second owner: the membership comes from the canonical store
 * rows Sync wrote, the cursors from Sync's own frontier, and the freshness from the
 * observation Sync publishes. A local Source/text/tag filter on a Home that cannot
 * serve filtered listing therefore narrows Sync's corpus instead of paginating a
 * second one, so a bootstrap replace can neither orphan the filter's later pages nor
 * abort a page the filter is waiting on.
 */
export function buildOrdinarySessionListHomeState(input: Readonly<{
    serverId: string;
    requestedQueryKey: string;
    sessionIds: readonly string[];
    observation: SessionListHomeObservation | null | undefined;
    lifecycle: OrdinarySessionListLifecycle;
    /** `null` while this Home's transport ownership is being transferred. */
    online: boolean | null;
}>): SessionListQueryHomeState {
    const addresses = buildAddresses(input.serverId, input.sessionIds);
    const observedPhase = input.observation?.phase;
    const hasObservedRows = addresses.length > 0 || input.observation?.lastSuccessAt != null;
    const inFlight = input.lifecycle.fetchInFlight || input.lifecycle.fetchMoreInFlight;
    const failure = observedPhase === 'error' ? input.observation?.failure : undefined;
    const phase: SessionListQueryHomeState['phase'] =
        // An admitted refusal has settled even if its promise is still cleaning
        // up or the realtime socket is reconnecting. Account transfer remains pending.
        input.online !== null && observedPhase === 'error' && failure?.reason !== 'network'
            ? 'error'
            : input.online === false
                ? 'offline'
                : inFlight || input.online === null
                    ? (hasObservedRows ? 'refreshing' : 'loading')
                    : observedPhase === 'error'
                        ? 'error'
                        // The observation's "offline" is published when the socket drops; a transport that is
                        // back (`online`) outranks it, or a Home still paging would read as unreachable.
                        : observedPhase === 'offline' && input.online !== true
                            ? 'offline'
                            : input.lifecycle.hasFetchedSnapshot
                                ? 'ready'
                                : 'loading';
    return {
        requestedQueryKey: input.requestedQueryKey,
        // Sync's snapshot is the applied corpus for this Home; until it has landed
        // once, no membership has been applied and the surface stays pending.
        appliedQueryKey: input.lifecycle.hasFetchedSnapshot ? input.requestedQueryKey : null,
        addresses,
        nextCursor: input.lifecycle.frontier.nextCursor,
        hasNext: input.lifecycle.frontier.hasNext,
        attentionNextCursor: input.lifecycle.frontier.attentionNextCursor,
        attentionHasNext: input.lifecycle.frontier.attentionHasNext,
        phase,
        freshnessAt: input.observation?.lastSuccessAt ?? null,
        homeObservation: input.observation?.phase === phase
            ? input.observation
            : { phase, lastSuccessAt: input.observation?.lastSuccessAt ?? null },
        failureReason: phase === 'error' ? failure?.reason ?? 'response' : null,
        failureCode: phase === 'error' ? failure?.code ?? null : null,
        // Never `query`: a released GET cannot answer the strict query's structural
        // selection, so coverage owners must keep treating this corpus as ordinary.
        appliedSourceKind: 'ordinary',
        metadataUpgradeRequiredCount: input.lifecycle.frontier.metadataUpgradeRequiredCount ?? 0,
    };
}
