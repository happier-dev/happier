import type { PluginContributionIdentity } from '@happier-dev/plugin-sdk/manifest';
import type { TriageListInvocationErrorV1 } from '../actions/listEntriesProtocol.js';
import type { TriageListPinnedEntriesResultV1 } from '../actions/userMarksProtocol.js';
import {
    MAX_TRIAGE_LIST_WINDOW_ROWS_V1,
    triageTaskStatusCategoryV1,
    type TriageEntryRefV1,
    type TriageListSortV1,
    type TriageSourceFailureV1,
    type TriageSourceScanEvidenceV1,
    type TriageSourceEntrySnapshotV1,
} from '@happier-dev/triage-protocol/v1';

import { deriveDisplayedAttention, type CorpusDisplayedAttentionV1 } from '../corpus/attention/deriveAttention.js';
import { foldConnectionAnswers } from '../corpus/fold/connectionAnswer.js';
import { CORPUS_LANE, laneForSnapshot, sortAtMsFor, type CorpusLaneV1 } from '../corpus/fold/lane.js';
import { rollUpPresence, type CorpusPresenceV1 } from '../corpus/fold/presence.js';
import { sameTriageSourceIdentity } from '../corpus/identity/components.js';
import { rankCorpusWindow } from '../corpus/query/rankWindow.js';
import {
    CORPUS_DEFAULT_SMART_POLICY_V1,
    type CorpusSmartPolicyV1,
} from '../corpus/query/smartPolicy.js';
import type { CorpusEntryObservationsV1, ProjectedObservationV1 } from '../corpus/fold/projectedObservation.js';
import type { CorpusQualifiedObservationV1 } from '../corpus/fold/qualify.js';
import {
    selectObservationInstance,
    type CorpusSelectedInstanceV1,
} from '../corpus/selection/selectObservationInstance.js';
import {
    foldTriageSearchValue,
    parseTriageSearchQuery,
    projectTriageEntrySearchText,
    triageEntryMatchesSearch,
    type TriageEntrySearchTextV1,
} from './entrySearch.js';
import {
    retainTriageProjectionArray,
    retainTriageProjectionValue,
    retainTriageRowObservation,
} from './listWindowReconciliation.js';

/**
 * The one assembled PRs & Issues window.
 *
 * This module is the single place where a pass's qualified observations become
 * rows: the cross-connection fold, the canonical lane, the one displayed
 * attention result, the selected instance, the filter conjunction, the order
 * and the window bound all happen here and nowhere else. The aggregate list
 * Action assembles the window it returns through this owner, and the mounted
 * window store reassembles its merged lanes through the same one — so a row the
 * user sees is never produced by a second, similar-but-different projection.
 *
 * Nothing here is durable. The window exists for as long as the pass or mount
 * that produced it (`core/CORPUS.md` §4.4, §6.1).
 */

/**
 * How many rows one assembled window carries.
 *
 * This is the explicit V1 page-size contract retained by `PLAN.md` §0a A9.
 * It bounds one provider-work/result page; cross-invocation paging appends more
 * pages into the mounted projection. The protocol owner uses this geometry
 * when deriving the bounded Action presentation/control allocation.
 */
export { MAX_TRIAGE_LIST_WINDOW_ROWS_V1 } from '@happier-dev/triage-protocol/v1';

/**
 * How one configured source instance's lane ended in this pass.
 *
 * The first three arms are the source's own bounded scan evidence; `failed`
 * carries its typed failure; `unavailable` is the honest fourth arm for an
 * invocation that produced no evidence of either kind, which is not provider
 * evidence about the source at all.
 *
 * A scan that never answers is NOT `unavailable`. The scan owner bounds each
 * page with a deadline and classifies a lane that reaches it as `failed` with a
 * transient failure, because "this source did not answer in time" is a typed,
 * retryable statement about the source — whereas `unavailable` stays for an
 * invocation that rejected outright. Its optional diagnostic describes the
 * invocation refusal, never provider evidence about the source.
 */
export type TriageListLaneHealthV1 =
    | TriageSourceScanEvidenceV1
    | Readonly<{ kind: 'failed'; failure: TriageSourceFailureV1 }>
    | Readonly<{ kind: 'unavailable'; error?: TriageListInvocationErrorV1 }>;

export type TriageListLaneV1 = Readonly<{
    sourceInstanceId: string;
    source: PluginContributionIdentity;
    health: TriageListLaneHealthV1;
    /** Whether this lane reported a settled end of its walk in this pass. */
    exhausted: boolean;
}>;

/** The configured source instances a window set out to cover. */
export type TriageListIntendedSourceV1 = Readonly<{
    sourceInstanceId: string;
    source: PluginContributionIdentity;
}>;

/**
 * The lane set of one window: every source instance it **intended** to cover,
 * whether or not a pass could ask it.
 *
 * Coverage is a claim about what was asked, so a configured source with no
 * admitted contribution — or one an assembling mount has not walked yet — is a
 * lane that has not finished, not an absence from the lane set. Deriving the
 * lanes from the walk instead lets a window whose every *walked* lane finished
 * report `complete` while an entire connection was never reached, and an empty
 * list then tells the reader that every configured source answered.
 *
 * It is one owner because both the aggregate Action and the mounted store
 * assemble the same claim from different halves: the Action from the configured
 * rows it just read, the store from the per-instance passes it has merged.
 */
export function triageListCoverageLanes(input: Readonly<{
    intended: readonly TriageListIntendedSourceV1[];
    walked: readonly TriageListLaneV1[];
}>): readonly TriageListLaneV1[] {
    const walked = new Map(input.walked.map((lane) => [lane.sourceInstanceId, lane]));
    return Object.freeze(input.intended.map((instance) => walked.get(instance.sourceInstanceId) ?? Object.freeze({
        sourceInstanceId: instance.sourceInstanceId,
        source: instance.source,
        // Never asked is not provider evidence about the source, which is
        // exactly what the honest fourth health arm says.
        health: { kind: 'unavailable' } as const,
        exhausted: false,
    })));
}

/**
 * The one observation a row's content comes from.
 *
 * It is an explicit projection rather than a rule each reader applies, because a row whose
 * title, lane, ordinal and locator are each chosen by their own reader is a row
 * that can say *open* in the title and file itself under *Done* — silently, with
 * nothing to error on. This is the observation `core/CORPUS.md` §3.2 names, and
 * every surface reads it instead of choosing again. An unresolved exact reread retains
 * this last-good display value while its current observation remains unresolved.
 */
export type TriageListRowContentV1 = Readonly<{
    sourceInstanceId: string;
    observedAtMs: number;
    outcome: Extract<ProjectedObservationV1['outcome'], Readonly<{ kind: 'present' }>>;
}>;

/** One projected row: one canonical entry as every configured connection answered for it. */
export type TriageListRowV1 = Readonly<{
    entryRef: TriageEntryRefV1;
    /**
     * The observation this row's content, lane and ordinal come from, or `null`
     * when no connection has reported the entry. It may be last-good display
     * content after an unresolved exact reread; selection still uses current observations.
     */
    content: TriageListRowContentV1 | null;
    lane: CorpusLaneV1;
    /** Presentation ordinal only; it is never compared to a clock or a freshness claim. */
    sortAtMs: number;
    presence: CorpusPresenceV1;
    attention: CorpusDisplayedAttentionV1 | null;
    selected: CorpusSelectedInstanceV1;
    observations: CorpusEntryObservationsV1;
}>;

export type TriageListWindowV1 = Readonly<{
    v: 1;
    rows: readonly TriageListRowV1[];
    lanes: readonly TriageListLaneV1[];
    /**
     * Type and Scope identities observed before this lens applies search or
     * facets. The rail consumes this exact census rather than rediscovering
     * options from the already-filtered rows and trapping the reader inside a
     * narrowing choice. Coverage is the census's own lane truth, not a global
     * provider count.
     */
    facetCensus: TriageListFacetCensusV1;
    /** Blocked Tasks matching this Ready lens within the observed source window. */
    notReadyReasonCounts?: Readonly<{ blocker_not_terminal: number; blocker_unreadable: number }>;
    /**
     * `complete` only when every lane reported exhaustion and the row bound did
     * not truncate. A zero-row `partial` window is not an empty result.
     */
    coverage: 'complete' | 'partial';
    assembledAtMs: number;
}>;

/** Retained by the existing mount, including rows hidden by its current lens. Never crosses the wire. */
export type TriageListFoldBaselineV1 = {
    entries: Map<string, Readonly<{ row: TriageListRowV1; searchText: TriageEntrySearchTextV1 }>>;
    /** Null when seeded from a row without the preceding configured-source set (an exact reread). */
    activeSourceInstanceIds: Set<string> | null;
    window: TriageListWindowV1 | null;
};

export function createTriageListFoldBaselineV1(rows: readonly TriageListRowV1[] = []): TriageListFoldBaselineV1 {
    return {
        entries: new Map(rows.map(row => [triageEntryRowKey(row.entryRef), {
            row, searchText: projectTriageEntrySearchText(row.observations),
        }])),
        activeSourceInstanceIds: null,
        window: null,
    };
}

/**
 * The source-neutral filter vocabulary of `core/CORPUS.md` §6.2.
 *
 * Every value is a canonical private identity: no facet derives, persists or
 * routes through a Collection storage tag. Values within one non-empty facet
 * are alternatives; non-empty facets compose by conjunction, and selecting one
 * facet never clears or weakens another.
 */
export type CorpusSourceFilterValueV1 = Readonly<{ source: PluginContributionIdentity; sourceInstanceId?: string }>;
export type CorpusTypeFilterValueV1 = Readonly<{ source: PluginContributionIdentity; kindId: string }>;
export type CorpusScopeFilterValueV1 =
    | Readonly<{ source: PluginContributionIdentity; sourceInstanceId?: string; collisionScope: string; unitId?: never }>
    | Readonly<{ source: PluginContributionIdentity; sourceInstanceId?: string; unitId: string; collisionScope?: string }>
    | Readonly<{ source: PluginContributionIdentity; sourceInstanceId?: string; unitId?: never; collisionScope?: never }>;
export const TRIAGE_STATE_FILTER_VALUES_V1 = Object.freeze(['open', 'done', 'absent', 'unresolved'] as const);
export const TRIAGE_ATTENTION_FILTER_VALUES_V1 = Object.freeze(['required', 'suggested', 'none'] as const);
export type CorpusStateFilterValueV1 = (typeof TRIAGE_STATE_FILTER_VALUES_V1)[number];
export type CorpusAttentionFilterValueV1 = (typeof TRIAGE_ATTENTION_FILTER_VALUES_V1)[number];

/** The key one Scope value is named under in `TriageListFacetCensusV1.scopeNames`. */
export function triageFacetScopeKeyV1(source: PluginContributionIdentity, collisionScope: string): string {
    return JSON.stringify([source.pluginId, source.localId, collisionScope]);
}

/** Shared routes omit configured-instance identifiers used for client-local narrowing. */
export function triageSourceFilterKeyV1(value: CorpusSourceFilterValueV1): string {
    return JSON.stringify([value.source.pluginId, value.source.localId, value.sourceInstanceId ?? null]);
}

/** A unit's collision scope is a source-authored fallback join, not another unit identity. */
export function triageScopeFilterKeyV1(value: CorpusScopeFilterValueV1): string {
    return JSON.stringify([value.source.pluginId, value.source.localId, value.sourceInstanceId ?? null,
        value.unitId === undefined ? ['scope', value.collisionScope ?? null] : ['unit', value.unitId]]);
}

export type TriageListFacetCensusV1 = Readonly<{
    types: readonly CorpusTypeFilterValueV1[];
    scopes: readonly CorpusScopeFilterValueV1[];
    labels?: readonly string[];
    /**
     * Each observed Scope's display name, by `triageFacetScopeKeyV1`: the same name its rows say
     * ("happier"), not the protocol identity (`github:1117388084`). A scope no observation named is
     * absent, and the rail falls back to its identity.
     */
    scopeNames: Readonly<Record<string, string>>;
    coverage: 'complete' | 'partial';
}>;

export type SurfaceFilterSelectionV1 = Readonly<{
    /** Tasks is a lens over the same materialized rows; links are joined by the Collection projector. */
    tasks?: 'mine' | 'agents' | 'everyone';
    sources: readonly CorpusSourceFilterValueV1[];
    types: readonly CorpusTypeFilterValueV1[];
    scopes: readonly CorpusScopeFilterValueV1[];
    states: readonly CorpusStateFilterValueV1[];
    attention: readonly CorpusAttentionFilterValueV1[];
    labels?: readonly string[];
    ready?: boolean;
}>;

export const TRIAGE_LIST_NO_FILTERS_V1: SurfaceFilterSelectionV1 = Object.freeze({
    sources: Object.freeze([]),
    types: Object.freeze([]),
    scopes: Object.freeze([]),
    states: Object.freeze([]),
    attention: Object.freeze([]),
});

/** The three built-in orders. `smart` is a window-local re-rank, never a persisted score. */
export const TRIAGE_LIST_ORDERS_V1 = Object.freeze(['newest', 'oldest', 'smart'] as const);
export type TriageListOrderV1 = (typeof TRIAGE_LIST_ORDERS_V1)[number];

/** The one lens every consumer of the shared window reads through. */
export type TriageListLensV1 = Readonly<{
    /** The Tasks page supplies its calendar boundary; no source chooses a retention policy. */
    tasks?: Readonly<{ completedSinceMs: number }>;
    /** Exact Task revisions whose mounted Session join observed release. Local to this window. */
    releasedClaimVersions?: Readonly<Record<string, number>>;
    order: TriageListOrderV1;
    /** Explicit source ordering is acquired before paging, never locally re-ranked. */
    sort?: TriageListSortV1;
    /**
     * The bounded Smart precedence policy. It is carried on every lens, not
     * only a `smart` one, because a saved view retains it across a non-Smart
     * order switch: dropping it here would silently reset the user's preference
     * the moment they looked at the list by date.
     */
    smartPolicy: CorpusSmartPolicyV1;
    /** The settled search text. IME-intermediate text never reaches it. */
    query: string;
    filters: SurfaceFilterSelectionV1;
    limit: number;
}>;

/** Shared by the list Action, mounted window and pins; unknown dates cannot establish membership. */
export function triageTaskCompletionMatchesWindowV1(
    snapshot: TriageSourceEntrySnapshotV1,
    sinceMs: number | undefined,
): boolean {
    return sinceMs === undefined || triageTaskStatusCategoryV1(snapshot.state) !== 'completed'
        || snapshot.completedAtMs !== undefined && snapshot.completedAtMs >= sinceMs;
}

export const TRIAGE_LIST_DEFAULT_LENS_V1: TriageListLensV1 = Object.freeze({
    order: 'newest',
    smartPolicy: CORPUS_DEFAULT_SMART_POLICY_V1,
    query: '',
    filters: TRIAGE_LIST_NO_FILTERS_V1,
    limit: MAX_TRIAGE_LIST_WINDOW_ROWS_V1,
});

/**
 * The one row key of a canonical entry reference: the fold's grouping key and
 * the surfaces' presentation key.
 *
 * Deliberately a JSON array encoding rather than a delimiter join: `U+001F` is
 * representable inside `collisionScope`, so joining components would merge two
 * contract-valid distinct entries into one row. JSON string escaping is
 * injective over the ordered components, so this key cannot collide.
 *
 * It is exported because the pinned-row join keys projected rows against rows
 * this fold grouped, so the two must be the same encoder rather than two
 * encoders that agree today: a drift in either one silently lists a pinned entry
 * twice or drops it from the join, with nothing to error on.
 */
export function triageEntryRowKey(entryRef: TriageEntryRefV1): string {
    return JSON.stringify([
        entryRef.source.pluginId,
        entryRef.source.localId,
        entryRef.kindId,
        entryRef.collisionScope,
        entryRef.entryId,
    ]);
}

/**
 * The one present observation this row's content comes from: the
 * lexicographically smallest stable `sourceInstanceId` (`core/CORPUS.md` §3.2).
 *
 * It is deliberately **not** a freshness claim. Two connections' `observedAtMs`
 * values come from two machines' clocks and `sourceUpdatedAtMs` values from two
 * providers' clocks, and §3.2 forbids comparing either pair across instances: a
 * provider whose clock runs ahead wins once and then wins every subsequent
 * comparison, freezing the entry with no error anywhere. A stable id also makes
 * the answer order-independent, which an arrival-order winner is not.
 *
 * Within one connection its own clock *is* comparable, so the same connection
 * answering twice in one pass — the same entry on two pages — contributes its
 * newest answer.
 *
 * What this costs is stated in §3.2 and must not be "fixed" with an ordinal: the
 * displayed snapshot may come from the alphabetically first connection rather
 * than the most recently updated one. It loses no observation, and it decides no
 * absence, attention or authority — those read the observations directly.
 */
function contentObservation(observations: CorpusEntryObservationsV1): TriageListRowContentV1 | null {
    let winner: TriageListRowContentV1 | null = null;
    for (const observation of observations) {
        if (observation.outcome.kind !== 'present') continue;
        const candidate: TriageListRowContentV1 = {
            sourceInstanceId: observation.sourceInstanceId,
            observedAtMs: observation.observedAtMs,
            outcome: observation.outcome,
        };
        if (winner === null
            || candidate.sourceInstanceId < winner.sourceInstanceId
            || (candidate.sourceInstanceId === winner.sourceInstanceId
                && candidate.observedAtMs > winner.observedAtMs)) {
            winner = candidate;
        }
    }
    return winner;
}

/** The presentation ordinal of the observation the row's content came from. */
function sortAtMsForContent(content: TriageListRowContentV1): number {
    return sortAtMsFor({
        snapshot: content.outcome.snapshot,
        ...(content.outcome.sourceUpdatedAtMs === undefined
            ? {}
            : { sourceUpdatedAtMs: content.outcome.sourceUpdatedAtMs }),
        observedAtMs: content.observedAtMs,
    });
}

function latestObservedAtMs(observations: CorpusEntryObservationsV1): number {
    let latest = 0;
    for (const observation of observations) latest = Math.max(latest, observation.observedAtMs);
    return latest;
}

type TriageListFilterFactsV1 = Readonly<{
    entryRef: TriageEntryRefV1;
    content?: TriageListRowContentV1 | null;
    observations?: CorpusEntryObservationsV1;
    presence?: CorpusPresenceV1;
    lane?: CorpusLaneV1;
    attention?: CorpusDisplayedAttentionV1 | null;
}>;

function matchesState(row: TriageListFilterFactsV1, states: readonly CorpusStateFilterValueV1[]): boolean {
    if (states.length === 0) return true;
    for (const state of states) {
        if (state === 'absent' && row.presence?.kind === 'absent') return true;
        if (state === 'unresolved' && row.presence?.kind === 'unresolved') return true;
        if (row.presence?.kind !== 'present') continue;
        if (state === 'open' && row.lane === CORPUS_LANE.open) return true;
        if (state === 'done' && row.lane === CORPUS_LANE.done) return true;
    }
    return false;
}

function matchesAttention(
    row: TriageListFilterFactsV1,
    attention: readonly CorpusAttentionFilterValueV1[],
): boolean {
    if (attention.length === 0) return true;
    if (row.attention === undefined) return false;
    const level = row.attention?.level ?? 'none';
    return attention.includes(level);
}

function typeFilterKey(value: CorpusTypeFilterValueV1): string {
    return `${JSON.stringify([value.source.pluginId, value.source.localId])}:${JSON.stringify(value.kindId)}`;
}

function matchesFilters(row: TriageListFilterFactsV1, filters: SurfaceFilterSelectionV1): boolean {
    if (filters.sources.length > 0
        && !filters.sources.some((value) => sameTriageSourceIdentity(value.source, row.entryRef.source)
            && (value.sourceInstanceId === undefined
                || row.observations?.some((observation) => observation.sourceInstanceId === value.sourceInstanceId)))) {
        return false;
    }
    if (filters.types.length > 0 && !filters.types.some(
        (value) => sameTriageSourceIdentity(value.source, row.entryRef.source) && value.kindId === row.entryRef.kindId,
    )) {
        return false;
    }
    if (filters.scopes.length > 0 && !filters.scopes.some(
        (value) => sameTriageSourceIdentity(value.source, row.entryRef.source)
            && (row.observations === undefined
                ? value.sourceInstanceId === undefined && value.unitId === undefined
                    && (value.collisionScope === undefined || value.collisionScope === row.entryRef.collisionScope)
                : row.observations.some((observation) => {
                    if (value.sourceInstanceId !== undefined && value.sourceInstanceId !== observation.sourceInstanceId) return false;
                    if (value.unitId !== undefined) {
                        const unitId = observation.outcome.kind === 'present' ? observation.outcome.snapshot.scopeUnitId : undefined;
                        return unitId === undefined
                            ? value.collisionScope !== undefined && value.collisionScope === row.entryRef.collisionScope
                            : unitId === value.unitId;
                    }
                    return value.collisionScope === undefined || value.collisionScope === row.entryRef.collisionScope;
                })),
    )) {
        return false;
    }
    if (filters.labels?.length && (row.presence?.kind !== 'present'
        || !filters.labels.some(label => row.content?.outcome.snapshot.labels?.includes(label)))) return false;
    return matchesState(row, filters.states) && matchesAttention(row, filters.attention);
}

/** Pins retain identity and display text, but cannot claim unread status, attention or connection facts. */
export function createTriageListLensMatcherV1(
    lens: Pick<TriageListLensV1, 'query' | 'filters' | 'releasedClaimVersions'>,
    notReadyReasonCounts?: { blocker_not_terminal: number; blocker_unreadable: number },
) {
    const terms = parseTriageSearchQuery(lens.query);
    return (entry: TriageListRowV1 | TriageListPinnedEntriesResultV1['pins'][number],
        searchText?: TriageEntrySearchTextV1): boolean => {
        if (!matchesFilters(entry, lens.filters)) return false;
        const text = searchText ?? ('observations' in entry
            ? projectTriageEntrySearchText(entry.observations)
            : [entry.displayAtMark.title, entry.displayAtMark.scopeLabel].map(foldTriageSearchValue));
        if (!triageEntryMatchesSearch(text, terms)) return false;
        if (lens.filters.ready === undefined) return true;
        if (!('presence' in entry) || entry.presence.kind !== 'present') return false;
        const snapshot = entry.content?.outcome.snapshot;
        const readiness = snapshot?.taskReadiness;
        if (notReadyReasonCounts && readiness?.ready === false
            && (readiness.reason === 'blocker_not_terminal' || readiness.reason === 'blocker_unreadable')) {
            notReadyReasonCounts[readiness.reason] += 1;
        }
        const released = readiness?.ready === false && readiness.reason === 'task_claimed' && snapshot?.version !== undefined
            && lens.releasedClaimVersions?.[triageEntryRowKey(entry.entryRef)] === snapshot.version;
        return (released ? true : readiness?.ready) === lens.filters.ready;
    };
}

/**
 * Bound one ordered window fairly across the connections that answered for it
 * (`core/CORPUS.md` §4.3).
 *
 * A page of the aggregate list is assembled from several connections, and one
 * deep source must not consume the whole page budget. Cutting the globally
 * ranked window at the limit does exactly that: a connection holding 500 recent
 * entries fills every row of a `newest` window and a connection holding three
 * older ones is invisible — which reads as a missing integration rather than as
 * a paging choice, and which no error, health arm or coverage claim reports,
 * because every lane genuinely finished its walk.
 *
 * So rows are taken one at a time in rotation over the connections, in stable id
 * order, before any connection takes a second one. A row several connections
 * observed is taken once and skipped on the other connections' turns rather than
 * spending them, so a connection whose entries are all shared is not starved by
 * its own overlap. The rotation decides only *which* rows the window carries;
 * the order the reader sees stays the lens's, so this is a bound and never a
 * second ranker.
 *
 * The common case costs nothing: a window that fits its limit is returned
 * unchanged.
 */
function boundAcrossSourceLanes(
    ordered: readonly TriageListRowV1[],
    limit: number,
): readonly TriageListRowV1[] {
    if (ordered.length <= limit) return ordered;

    const queues = new Map<string, TriageListRowV1[]>();
    for (const row of ordered) {
        for (const observation of row.observations) {
            const queue = queues.get(observation.sourceInstanceId);
            if (queue === undefined) {
                queues.set(observation.sourceInstanceId, [row]);
                continue;
            }
            // One connection may answer for one entry twice in a pass; that is
            // one row of its lane, not two.
            if (queue[queue.length - 1] !== row) queue.push(row);
        }
    }

    // Stable id order, never arrival order: two lanes legitimately answer in a
    // different order on every pass, and a rotation that depended on it would
    // reshuffle which rows a reader can see.
    const rotation = [...queues.keys()].sort();
    const cursors = new Map<string, number>(rotation.map((sourceInstanceId) => [sourceInstanceId, 0]));
    const taken = new Set<TriageListRowV1>();

    let placedThisRotation = true;
    while (taken.size < limit && placedThisRotation) {
        placedThisRotation = false;
        for (const sourceInstanceId of rotation) {
            if (taken.size >= limit) break;
            const queue = queues.get(sourceInstanceId) ?? [];
            let cursor = cursors.get(sourceInstanceId) ?? 0;
            while (cursor < queue.length && taken.has(queue[cursor])) cursor += 1;
            if (cursor >= queue.length) {
                cursors.set(sourceInstanceId, cursor);
                continue;
            }
            taken.add(queue[cursor]);
            cursors.set(sourceInstanceId, cursor + 1);
            placedThisRotation = true;
        }
    }

    return ordered.filter((row) => taken.has(row));
}

/**
 * Fold one pass's qualified observations into one bounded ordered window.
 *
 * `activeSourceInstanceIds` is what makes detail and mutation routing honest: a
 * retired instance's observation still folds into presence and attention, but it
 * can never be selected to run anything.
 */
export function foldTriageListWindow(input: Readonly<{
    observations: readonly CorpusQualifiedObservationV1[];
    /** Every lane this window intended to cover — see `triageListCoverageLanes`. */
    lanes: readonly TriageListLaneV1[];
    /**
     * Whether the configured set behind those lanes could be enumerated whole.
     * `truncated` means at least one configured source is not even named here,
     * so no arrangement of the lanes below can make this window complete.
     */
    configuredSourcesStatus: 'complete' | 'truncated';
    activeSourceInstanceIds: Iterable<string>;
    lens: TriageListLensV1;
    assembledAtMs: number;
    baseline?: TriageListFoldBaselineV1;
    /** Owner diagnostic: one semantic row derivation, independent of global lens/order traversal. */
    onRowProjected?: (entryRef: TriageEntryRefV1) => void;
}>): TriageListWindowV1 {
    const activeSourceInstanceIds = [...input.activeSourceInstanceIds];
    const active = new Set(activeSourceInstanceIds);
    const baseline = input.baseline;
    const grouped = new Map<string, { entryRef: TriageEntryRefV1; observations: ProjectedObservationV1[] }>();
    for (const observation of input.observations) {
        const key = triageEntryRowKey(observation.entryRef);
        const bucket = grouped.get(key);
        // The canonical ref is discarded from the projected observation: a record
        // carrying both a row identity and an inner one carries two identities
        // that can disagree.
        const projected: ProjectedObservationV1 = {
            sourceInstanceId: observation.sourceInstanceId,
            observedAtMs: observation.observedAtMs,
            outcome: observation.outcome,
        };
        if (bucket === undefined) {
            grouped.set(key, { entryRef: observation.entryRef, observations: [projected] });
            continue;
        }
        bucket.observations.push(projected);
    }

    const unfilteredRows: TriageListRowV1[] = [];
    const rows: TriageListRowV1[] = [];
    const notReadyReasonCounts = input.lens.filters.ready === true
        ? { blocker_not_terminal: 0, blocker_unreadable: 0 } : undefined;
    const matchesLens = createTriageListLensMatcherV1(input.lens, notReadyReasonCounts);
    for (const [key, { entryRef, observations: answers }] of grouped) {
        // One connection answering for one entry several times in a pass is one
        // connection's answer, unioned. It happens here, before anything reads
        // the row, because every reader below — content, attention, selection,
        // the wire — sees at most one observation per connection and would
        // otherwise each pick a different encounter's facts.
        const previous = baseline?.entries.get(key);
        const previousAnswers = previous?.row.observations;
        const previousByInstance = previousAnswers !== undefined && previousAnswers.length > 1
            ? new Map(previousAnswers.map(observation => [observation.sourceInstanceId, observation])) : undefined;
        const foldedAnswers = answers.length === 1 ? answers : foldConnectionAnswers(answers);
        const observations = retainTriageProjectionArray(previous?.row.observations,
            foldedAnswers.map(observation => retainTriageRowObservation(
                previousByInstance?.get(observation.sourceInstanceId)
                    ?? previousAnswers?.find(previous => previous.sourceInstanceId === observation.sourceInstanceId), observation,
            )));
        const previousActive = baseline?.activeSourceInstanceIds;
        const selectionChanged = previous !== undefined && (previousActive == null
            ? retainTriageProjectionValue(previous.row.selected,
                selectObservationInstance(observations, activeSourceInstanceIds, previous.row.attention)) !== previous.row.selected
            : observations.some(observation => observation.outcome.kind === 'present'
                && active.has(observation.sourceInstanceId) !== previousActive.has(observation.sourceInstanceId)));
        let row = previous?.row;
        let searchText = previous?.searchText;
        if (row === undefined || row.observations !== observations || selectionChanged) {
            input.onRowProjected?.(entryRef);
            const attention = retainTriageProjectionValue(row?.attention, deriveDisplayedAttention(observations));
            const content = retainTriageProjectionValue(row?.content, contentObservation(observations));
            row = Object.freeze({
                entryRef: row?.entryRef ?? entryRef,
                content,
                // An entry with no present observation is not finished; calling it
                // done because a connection failed would retire a live entry.
                lane: content === null ? CORPUS_LANE.open : laneForSnapshot(content.outcome.snapshot),
                sortAtMs: content === null ? latestObservedAtMs(observations) : sortAtMsForContent(content),
                presence: retainTriageProjectionValue(row?.presence, rollUpPresence(observations)),
                attention,
                selected: retainTriageProjectionValue(row?.selected, selectObservationInstance(observations, activeSourceInstanceIds, attention)),
                observations,
            });
            searchText = projectTriageEntrySearchText(observations);
            baseline?.entries.set(key, { row, searchText });
        }
        unfilteredRows.push(row);
        if ((row.content === null || triageTaskCompletionMatchesWindowV1(row.content.outcome.snapshot, input.lens.tasks?.completedSinceMs))
            && matchesLens(row, searchText)) rows.push(row);
    }

    // Ordering has one owner, and it is not this assembler: `rankCorpusWindow`
    // is the sole comparator for every built-in order, so `smart` cannot drift
    // from the policy a saved view persisted.
    const ordered = input.lens.sort === undefined
        ? rankCorpusWindow(rows, input.lens.order, input.lens.smartPolicy)
        : rows;
    // The lens's own bound, and nothing narrower. `MAX_TRIAGE_LIST_WINDOW_ROWS_V1`
    // is the bound of ONE Action RESULT, so it belongs to the wire owner that
    // pays for it (`actions/listEntriesProtocol.ts` declares it as the input's
    // maximum and the result array's `maxItems`), not to this projection. A
    // mounted store that has appended several successive bounded windows folds
    // its whole accumulated page through this owner and crosses no wire doing
    // it; clamping here made every appended window invisible past the first.
    const limit = Math.max(0, input.lens.limit);
    const bounded = boundAcrossSourceLanes(ordered, limit);
    const everyLaneExhausted = input.lanes.every((lane) => lane.exhausted);
    const censusComplete = input.configuredSourcesStatus === 'complete'
        // A window that asked no lane has no basis for saying every configured
        // source answered, and `lanes.every` is vacuously true over none — which
        // is how an enumeration-only read reported an authoritative "nothing
        // needs you" from a call that asked nobody.
        && input.lanes.length > 0
        && everyLaneExhausted;
    const complete = censusComplete
        && bounded.length === ordered.length;

    const previousWindow = baseline?.window;
    const previousCensus = previousWindow?.facetCensus;
    const previousTypes = new Map(previousCensus?.types.map(value => [typeFilterKey(value), value]));
    const previousScopes = new Map(previousCensus?.scopes.map(value => [triageScopeFilterKeyV1(value), value]));
    const typeValues = new Map<string, CorpusTypeFilterValueV1>();
    const scopeValues = new Map<string, CorpusScopeFilterValueV1>();
    const labelValues = new Set<string>();
    const scopeNames: Record<string, string> = {};
    for (const row of unfilteredRows) {
        const snapshot = row.content?.outcome.snapshot;
        if (row.presence.kind === 'present') {
            for (const label of snapshot?.labels ?? []) if (label.length > 0) labelValues.add(label);
        }
        const scopeName = snapshot?.scopeLabel;
        if (scopeName !== undefined && scopeName.length > 0) {
            scopeNames[triageFacetScopeKeyV1(row.entryRef.source, row.entryRef.collisionScope)] ??= scopeName;
        }
        const type = {
            source: row.entryRef.source,
            kindId: row.entryRef.kindId,
        };
        const typeKey = typeFilterKey(type);
        typeValues.set(typeKey, previousTypes.get(typeKey) ?? Object.freeze(type));
        for (const observation of row.observations) {
            const snapshot = observation.outcome.kind === 'present' ? observation.outcome.snapshot : undefined;
            const scope: CorpusScopeFilterValueV1 = snapshot?.scopeUnitId === undefined
                ? { source: row.entryRef.source, collisionScope: row.entryRef.collisionScope }
                : { source: row.entryRef.source, sourceInstanceId: observation.sourceInstanceId, unitId: snapshot.scopeUnitId };
            const key = triageScopeFilterKeyV1(scope);
            scopeValues.set(key, retainTriageProjectionValue(previousScopes.get(key), Object.freeze(scope)));
            const name = snapshot?.scopeLabel;
            if (name) scopeNames[key] ??= name;
        }
    }
    const types = retainTriageProjectionArray(previousCensus?.types,
        [...typeValues.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([, value]) => value));
    const scopes = retainTriageProjectionArray(previousCensus?.scopes,
        [...scopeValues.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([, value]) => value));
    const retainedScopeNames = retainTriageProjectionValue(previousCensus?.scopeNames, Object.freeze(scopeNames));
    const labels = labelValues.size === 0 ? undefined : retainTriageProjectionArray(previousCensus?.labels, [...labelValues].sort());
    const censusCoverage = censusComplete ? 'complete' : 'partial';
    const facetCensus: TriageListFacetCensusV1 = previousCensus !== undefined && previousCensus.types === types
        && previousCensus.scopes === scopes && previousCensus.scopeNames === retainedScopeNames
        && previousCensus.labels === labels
        && previousCensus.coverage === censusCoverage ? previousCensus : Object.freeze({
            types, scopes, scopeNames: retainedScopeNames, coverage: censusCoverage,
            ...(labels === undefined ? {} : { labels }),
        });

    // The producer knows which rows, order and coverage changed. It never serializes a rebuilt window.
    const retainedRows = retainTriageProjectionArray(previousWindow?.rows, bounded);
    const previousLanes = new Map(previousWindow?.lanes.map(lane => [lane.sourceInstanceId, lane]));
    const retainedLanes = retainTriageProjectionArray(previousWindow?.lanes,
        input.lanes.map(lane => retainTriageProjectionValue(previousLanes.get(lane.sourceInstanceId), lane)));
    const coverage = complete ? 'complete' : 'partial';
    const retainedNotReadyReasonCounts = retainTriageProjectionValue(
        previousWindow?.notReadyReasonCounts, notReadyReasonCounts === undefined ? undefined : Object.freeze(notReadyReasonCounts),
    );
    const next = previousWindow != null && retainedRows === previousWindow.rows
        && retainedLanes === previousWindow.lanes && facetCensus === previousWindow.facetCensus
        && retainedNotReadyReasonCounts === previousWindow.notReadyReasonCounts
        && coverage === previousWindow.coverage ? previousWindow : Object.freeze({
        v: 1,
        rows: retainedRows,
        lanes: retainedLanes,
        facetCensus,
        ...(retainedNotReadyReasonCounts === undefined ? {} : { notReadyReasonCounts: retainedNotReadyReasonCounts }),
        coverage,
        assembledAtMs: input.assembledAtMs,
    });
    if (baseline !== undefined) {
        for (const key of baseline.entries.keys()) {
            if (!grouped.has(key)) baseline.entries.delete(key);
        }
        baseline.activeSourceInstanceIds = active;
        baseline.window = next;
    }
    return next;
}

function keepPriorSelectionFacts(input: Readonly<{
    row: TriageListRowV1;
    observation: CorpusQualifiedObservationV1;
}>): CorpusQualifiedObservationV1 {
    const read = input.observation.outcome;
    const prior = input.row.observations.find(
        (candidate) => candidate.sourceInstanceId === input.observation.sourceInstanceId,
    )?.outcome;
    if (read.kind !== 'present' || prior?.kind !== 'present') return input.observation;
    const viewer = read.viewer.involvement.length === 0 ? prior.viewer : read.viewer;
    const oldHead = prior.snapshot.reviewRevision?.headSha;
    const newHead = read.snapshot.reviewRevision?.headSha;
    // A newly observed head invalidates a prior head's check/review summary.
    if (oldHead !== undefined && newHead !== undefined && oldHead !== newHead) {
        return { ...input.observation, outcome: { ...read, viewer } };
    }
    const facts = new Map(prior.snapshot.facts.map((fact) => [fact.id, fact]));
    for (const fact of read.snapshot.facts) {
        if (fact.value.kind !== 'detailOnly' || !facts.has(fact.id)) facts.set(fact.id, fact);
    }
    const rank = { primary: 0, secondary: 1, supplementary: 2 } as const;
    const ordered = [...facts.values()].sort((left, right) => rank[left.importance] - rank[right.importance]);
    return { ...input.observation, outcome: { ...read, viewer, snapshot: {
        ...read.snapshot,
        facts: ordered,
    } } };
}

/**
 * Rejoin one exact post-mutation observation through the ordinary aggregate fold.
 *
 * The targeted `get` replaces only its connection's older answer. Content selection, presence,
 * attention, lane and source selection are recomputed by the same owner as a list pass; this
 * function deliberately contains none of those decisions itself.
 */
export function foldTriagePostMutationObservation(input: Readonly<{
    /** An explicit pin-open can make the first observation of this entry. */
    row: TriageListRowV1 | null;
    observation: CorpusQualifiedObservationV1;
    /** Current configured-source lanes; observations outside this set are retained but retired. */
    lanes: readonly TriageListLaneV1[];
    /** An exact read can establish active admission independently of a successful list scan. */
    activeSourceInstanceIds?: Iterable<string>;
    assembledAtMs: number;
    /**
     * The read was only to open the entry. It states the revision's facts and no viewer facts (only a
     * list scan learns why an entry is the reader's), so the connection's earlier viewer facts stay.
     * Its unanswered row facts also remain until the exact read supplies a value.
     * Absent after a press, where the read is the new truth.
     */
    keepViewerFacts?: boolean;
}>): TriageListRowV1 | null {
    if (input.row !== null && triageEntryRowKey(input.row.entryRef) !== triageEntryRowKey(input.observation.entryRef)) {
        return null;
    }
    const observation = input.keepViewerFacts === true && input.row !== null
        ? keepPriorSelectionFacts({ ...input, row: input.row }) : input.observation;
    const retained: CorpusQualifiedObservationV1[] = (input.row?.observations ?? [])
        .filter((observation) => observation.sourceInstanceId !== input.observation.sourceInstanceId)
        .map((observation) => ({ ...observation, entryRef: input.observation.entryRef }));
    const folded = foldTriageListWindow({
        ...(input.row === null ? {} : { baseline: createTriageListFoldBaselineV1([input.row]) }),
        observations: [...retained, observation],
        lanes: input.lanes,
        configuredSourcesStatus: 'complete',
        activeSourceInstanceIds: input.activeSourceInstanceIds ?? input.lanes.map((lane) => lane.sourceInstanceId),
        lens: { ...TRIAGE_LIST_DEFAULT_LENS_V1, limit: 1 },
        assembledAtMs: input.assembledAtMs,
    });
    const row = folded.rows[0];
    if (row === undefined) return null;
    if (observation.outcome.kind !== 'unresolved' || row.content !== null || input.row === null) return row;
    // A failed exact read says nothing new about content or attention. Keep the
    // existing display facts, but retain the new failure/presence/selection so
    // the last-good snapshot cannot become current source authority.
    return Object.freeze({
        ...row,
        content: input.row.content,
        lane: input.row.lane,
        sortAtMs: input.row.sortAtMs,
        attention: input.row.attention,
    });
}
