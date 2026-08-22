import type { PluginContributionIdentity } from '@happier-dev/plugin-sdk/manifest';
import {
    type TriageEntryRefV1,
    type TriageSourceFailureV1,
    type TriageSourceScanEvidenceV1,
} from '@happier-dev/triage-protocol/v1';

import { deriveDisplayedAttention, type CorpusDisplayedAttentionV1 } from '../corpus/attention/deriveAttention.js';
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
    parseTriageSearchQuery,
    projectTriageEntrySearchText,
    triageEntryMatchesSearch,
} from './entrySearch.js';

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
 * It is the aggregate's own budget, derived from the aggregate's own gate — not
 * the source scan page's count. Aliasing the two was arithmetic coincidence
 * rather than a derivation: a scan page carries one snapshot per entry, while a
 * list row carries that snapshot plus the locator, the viewer facts the mounted
 * store re-derives attention from, the cross-connection roll-up and the other
 * connections' answers. A window of N rows is therefore strictly larger than a
 * scan page of N entries, so one count cannot answer for both — and when
 * `MAX_TRIAGE_TEXT_UTF8_BYTES_V1` widened to fit non-Latin titles, the scan
 * page still fit its gate while the list result no longer fit this one.
 *
 * The list result is rejected **whole** at 1 MiB, before the manifest result
 * schema is ever consulted (`packages/protocol/src/plugins/actions/invocation.ts`
 * parses through `AgentRuntimeJsonValueV1Schema` first), so a window one byte
 * over shows the user no list at all rather than a shorter one. This count is
 * therefore chosen to keep the derived maximum inside the gate with the same
 * proportion of headroom the aggregate carried before the display bound moved,
 * rather than spending the gate to its last byte: the next additive field would
 * otherwise fail at a user's transport boundary instead of in the derivation.
 * `actions/maximumEncodedActionValue.test.ts` is where that arithmetic is paid
 * for, and it fails loudly the moment any bound beneath it moves again.
 */
export const MAX_TRIAGE_LIST_WINDOW_ROWS_V1 = 56;

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
 * invocation that rejected outright, where there is nothing typed to carry.
 */
export type TriageListLaneHealthV1 =
    | TriageSourceScanEvidenceV1
    | Readonly<{ kind: 'failed'; failure: TriageSourceFailureV1 }>
    | Readonly<{ kind: 'unavailable' }>;

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
 * It is a member rather than a rule each reader applies, because a row whose
 * title, lane, ordinal and locator are each chosen by their own reader is a row
 * that can say *open* in the title and file itself under *Done* — silently, with
 * nothing to error on. This is the observation `core/CORPUS.md` §3.2 names, and
 * every surface reads it instead of choosing again.
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
     * when no connection reports the entry at all.
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
     * `complete` only when every lane reported exhaustion and the row bound did
     * not truncate. A zero-row `partial` window is not an empty result.
     */
    coverage: 'complete' | 'partial';
    assembledAtMs: number;
}>;

/**
 * The source-neutral filter vocabulary of `core/CORPUS.md` §6.2.
 *
 * Every value is a canonical private identity: no facet derives, persists or
 * routes through a Collection storage tag. Values within one non-empty facet
 * are alternatives; non-empty facets compose by conjunction, and selecting one
 * facet never clears or weakens another.
 */
export type CorpusSourceFilterValueV1 = Readonly<{ source: PluginContributionIdentity }>;
export type CorpusTypeFilterValueV1 = Readonly<{ source: PluginContributionIdentity; kindId: string }>;
export type CorpusScopeFilterValueV1 = Readonly<{ source: PluginContributionIdentity; collisionScope: string }>;
export type CorpusStateFilterValueV1 = 'open' | 'done' | 'absent' | 'unresolved';
export type CorpusAttentionFilterValueV1 = 'required' | 'suggested' | 'none';

export type SurfaceFilterSelectionV1 = Readonly<{
    sources: readonly CorpusSourceFilterValueV1[];
    types: readonly CorpusTypeFilterValueV1[];
    scopes: readonly CorpusScopeFilterValueV1[];
    states: readonly CorpusStateFilterValueV1[];
    attention: readonly CorpusAttentionFilterValueV1[];
}>;

export const TRIAGE_LIST_NO_FILTERS_V1: SurfaceFilterSelectionV1 = Object.freeze({
    sources: Object.freeze([]),
    types: Object.freeze([]),
    scopes: Object.freeze([]),
    states: Object.freeze([]),
    attention: Object.freeze([]),
});

/** The three built-in orders. `smart` is a window-local re-rank, never a persisted score. */
export type TriageListOrderV1 = 'newest' | 'oldest' | 'smart';

/** The one lens every consumer of the shared window reads through. */
export type TriageListLensV1 = Readonly<{
    order: TriageListOrderV1;
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

function matchesState(row: TriageListRowV1, states: readonly CorpusStateFilterValueV1[]): boolean {
    if (states.length === 0) return true;
    for (const state of states) {
        if (state === 'absent' && row.presence.kind === 'absent') return true;
        if (state === 'unresolved' && row.presence.kind === 'unresolved') return true;
        if (row.presence.kind !== 'present') continue;
        if (state === 'open' && row.lane === CORPUS_LANE.open) return true;
        if (state === 'done' && row.lane === CORPUS_LANE.done) return true;
    }
    return false;
}

function matchesAttention(
    row: TriageListRowV1,
    attention: readonly CorpusAttentionFilterValueV1[],
): boolean {
    if (attention.length === 0) return true;
    const level = row.attention?.level ?? 'none';
    return attention.includes(level);
}

function matchesFilters(row: TriageListRowV1, filters: SurfaceFilterSelectionV1): boolean {
    if (filters.sources.length > 0
        && !filters.sources.some((value) => sameTriageSourceIdentity(value.source, row.entryRef.source))) {
        return false;
    }
    if (filters.types.length > 0 && !filters.types.some(
        (value) => sameTriageSourceIdentity(value.source, row.entryRef.source) && value.kindId === row.entryRef.kindId,
    )) {
        return false;
    }
    if (filters.scopes.length > 0 && !filters.scopes.some(
        (value) => sameTriageSourceIdentity(value.source, row.entryRef.source)
            && value.collisionScope === row.entryRef.collisionScope,
    )) {
        return false;
    }
    return matchesState(row, filters.states) && matchesAttention(row, filters.attention);
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
}>): TriageListWindowV1 {
    const activeSourceInstanceIds = [...input.activeSourceInstanceIds];
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

    const rows: TriageListRowV1[] = [];
    const terms = parseTriageSearchQuery(input.lens.query);
    for (const { entryRef, observations } of grouped.values()) {
        const attention = deriveDisplayedAttention(observations);
        const content = contentObservation(observations);
        const row: TriageListRowV1 = {
            entryRef,
            content,
            // An entry with no present observation is not finished; calling it
            // done because a connection failed would retire a live entry.
            lane: content === null ? CORPUS_LANE.open : laneForSnapshot(content.outcome.snapshot),
            sortAtMs: content === null ? latestObservedAtMs(observations) : sortAtMsForContent(content),
            presence: rollUpPresence(observations),
            attention,
            selected: selectObservationInstance(observations, activeSourceInstanceIds, attention, null),
            observations,
        };
        // Search has one owner, shared with the Composer picker: two matchers
        // over one projection gave the same query two answers.
        const matchesQuery = triageEntryMatchesSearch(
            projectTriageEntrySearchText(observations),
            terms,
        );
        if (matchesFilters(row, input.lens.filters) && matchesQuery) rows.push(row);
    }

    // Ordering has one owner, and it is not this assembler: `rankCorpusWindow`
    // is the sole comparator for every built-in order, so `smart` cannot drift
    // from the policy a saved view persisted.
    const ordered = rankCorpusWindow(rows, input.lens.order, input.lens.smartPolicy);
    const limit = Math.max(0, Math.min(input.lens.limit, MAX_TRIAGE_LIST_WINDOW_ROWS_V1));
    const bounded = boundAcrossSourceLanes(ordered, limit);
    const everyLaneExhausted = input.lanes.every((lane) => lane.exhausted);
    const complete = input.configuredSourcesStatus === 'complete'
        // A window that asked no lane has no basis for saying every configured
        // source answered, and `lanes.every` is vacuously true over none — which
        // is how an enumeration-only read reported an authoritative "nothing
        // needs you" from a call that asked nobody.
        && input.lanes.length > 0
        && everyLaneExhausted
        && bounded.length === ordered.length;

    return Object.freeze({
        v: 1,
        rows: Object.freeze(bounded),
        lanes: Object.freeze([...input.lanes]),
        coverage: complete ? 'complete' : 'partial',
        assembledAtMs: input.assembledAtMs,
    });
}
