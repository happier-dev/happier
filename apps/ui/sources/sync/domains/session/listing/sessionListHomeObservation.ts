import type { SessionListQueryHomeState } from './sessionListQueryController';
import { matchSessionBotFilterV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';
import type { SessionBotFilterV1 } from '@happier-dev/protocol/sessions/listing/query';

/**
 * Authoritative lifecycle phase of one Home's Session list. Query-backed Homes publish it from
 * `SessionListQueryHomeState`; ordinary Homes publish it from the incumbent concurrent list
 * runtime. Both use this one vocabulary so no surface invents a second freshness policy.
 */
export type SessionListHomeObservationPhase = SessionListQueryHomeState['phase'];

/**
 * The one raw currentness fact Lane 07 exposes for a Home.
 *
 * It is deliberately narrow: a phase the list owner actually established, plus the time of the
 * last successful list observation for that exact `serverId`. Everything a surface shows about
 * currentness is projected from this by `buildSessionContextFacts` — never from `Session.updatedAt`,
 * transcript or runtime activity, presence, or a per-surface clock.
 */
export type SessionListHomeObservation = Readonly<{
    phase: SessionListHomeObservationPhase;
    /** `null` until this Home has produced one successful list observation. */
    lastSuccessAt: number | null;
}>;

export type SessionListHomeObservationByServerId = Readonly<
    Record<string, SessionListHomeObservation | null | undefined>
>;

export function resolveOrdinarySessionListCoverage(input: Readonly<{
    serverId: string | null;
    hasFetchedSnapshot: boolean;
    phase: SessionListHomeObservationPhase | null | undefined;
    fetchInFlight: boolean;
    fetchMoreInFlight: boolean;
    hasNext: boolean;
    attentionHasNext: boolean;
    metadataUpgradeRequiredCount?: number;
}>): 'complete' | 'incomplete' {
    return input.serverId
        && input.hasFetchedSnapshot
        && input.phase === 'ready'
        && !input.fetchInFlight
        && !input.fetchMoreInFlight
        && !input.hasNext
        && !input.attentionHasNext
        && (input.metadataUpgradeRequiredCount ?? 0) === 0
        ? 'complete'
        : 'incomplete';
}

export type SessionListObservationCacheByServerId = Readonly<Record<string, Readonly<{
    listObservation?: SessionListHomeObservation | null;
}> | null | undefined>>;

/** Strict query coverage belongs to the exact applied query lifecycle, never its GET adapter. */
export function isSessionListQueryHomeCoverageComplete(input: Readonly<{
    state: SessionListQueryHomeState | undefined;
    requestedQueryKey: string;
    bot?: SessionBotFilterV1;
    rowsBySessionId?: Readonly<Record<string, Readonly<{ metadata?: unknown }> | undefined>>;
}>): boolean {
    const state = input.state;
    return Boolean(
        state
        && state.appliedQueryKey === input.requestedQueryKey
        && state.phase === 'ready'
        && !state.hasNext
        && !state.attentionHasNext
        && (state.metadataUpgradeRequiredCount ?? 0) === 0
        && state.appliedSourceKind === 'query'
        && (input.bot === undefined || state.addresses.every((address) => (
            matchSessionBotFilterV1(input.rowsBySessionId?.[address.sessionId]?.metadata, input.bot) !== 'unavailable'
        )))
    );
}

function normalizeLastSuccessAt(value: number | null | undefined): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Projects the query controller's per-Home state onto the shared observation fact. The controller
 * already owns `phase` and `freshnessAt`; this only renames them into the shared vocabulary so
 * query-backed and ordinary Homes reach the presentation owner through one shape.
 */
export function readSessionListHomeObservationFromQueryState(
    state: Pick<SessionListQueryHomeState, 'phase' | 'freshnessAt'> | null | undefined,
): SessionListHomeObservation | null {
    if (!state) return null;
    return { phase: state.phase, lastSuccessAt: normalizeLastSuccessAt(state.freshnessAt) };
}

/**
 * The single exact-Home observation projection consumed by Session rows and secondary surfaces.
 *
 * Ordinary list lifecycles publish through the incumbent cache for both active and retained Homes,
 * while mounted query controllers may provide a stricter corpus for the same Home. Merge those
 * owners here instead of teaching each surface which runtime happens to own a Home. An applied
 * query lifecycle wins, including a failed refresh: ordinary readiness still owns ordinary
 * membership, but it cannot make a failed strict query look current.
 */
export function buildSessionListHomeObservations(input: Readonly<{
    concurrentSessionListCacheByServerId?: SessionListObservationCacheByServerId | null;
    queryStatesByServerId?: Readonly<Record<string, Pick<SessionListQueryHomeState, 'phase' | 'freshnessAt' | 'appliedSourceKind'> | null | undefined>> | null;
}>): SessionListHomeObservationByServerId {
    const observations: Record<string, SessionListHomeObservation> = {};
    for (const serverId in input.concurrentSessionListCacheByServerId ?? {}) {
        if (!Object.prototype.hasOwnProperty.call(input.concurrentSessionListCacheByServerId, serverId)) continue;
        const observation = input.concurrentSessionListCacheByServerId?.[serverId]?.listObservation;
        if (observation) observations[serverId] = observation;
    }
    for (const serverId in input.queryStatesByServerId ?? {}) {
        if (!Object.prototype.hasOwnProperty.call(input.queryStatesByServerId, serverId)) continue;
        const queryState = input.queryStatesByServerId?.[serverId];
        if (!queryState
            || (queryState.appliedSourceKind !== 'query' && queryState.phase !== 'error')) continue;
        const observation = readSessionListHomeObservationFromQueryState(queryState);
        if (observation) {
            observations[serverId] = {
                phase: observation.phase,
                lastSuccessAt: observation.lastSuccessAt ?? observations[serverId]?.lastSuccessAt ?? null,
            };
        }
    }
    return observations;
}

export function areSessionListHomeObservationsEqual(
    left: SessionListHomeObservation | null | undefined,
    right: SessionListHomeObservation | null | undefined,
): boolean {
    if (left === right) return true;
    if (!left || !right) return false;
    return left.phase === right.phase && left.lastSuccessAt === right.lastSuccessAt;
}
