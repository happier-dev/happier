import type { PluginContributionIdentity } from '@happier-dev/plugin-sdk/manifest';
import {
    type TriageEntryRefV1,
    type TriageSourceEntrySnapshotV1,
    type TriageSourceFailureV1,
    type TriageSourceScanEvidenceV1,
} from '@happier-dev/triage-protocol/v1';

import { deriveDisplayedAttention, type CorpusDisplayedAttentionV1 } from '../corpus/attention/deriveAttention.js';
import { CORPUS_LANE, laneForSnapshot, sortAtMsFor, type CorpusLaneV1 } from '../corpus/fold/lane.js';
import { rollUpPresence, type CorpusPresenceV1 } from '../corpus/fold/presence.js';
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
 * invocation that never settled into either, which is not provider evidence
 * about the source at all.
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

/** One projected row: one canonical entry as every configured connection answered for it. */
export type TriageListRowV1 = Readonly<{
    entryRef: TriageEntryRefV1;
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
 * The grouping key of one canonical entry reference.
 *
 * Deliberately a JSON array encoding rather than a delimiter join: `U+001F` is
 * representable inside `collisionScope`, so joining components would merge two
 * contract-valid distinct entries into one row. JSON string escaping is
 * injective over the ordered components, so this key cannot collide.
 */
function entryKey(entryRef: TriageEntryRefV1): string {
    return JSON.stringify([
        entryRef.source.pluginId,
        entryRef.source.localId,
        entryRef.kindId,
        entryRef.collisionScope,
        entryRef.entryId,
    ]);
}

function sameSource(left: PluginContributionIdentity, right: PluginContributionIdentity): boolean {
    return left.pluginId === right.pluginId && left.localId === right.localId;
}

/** The newest present snapshot of one entry, by our own observation clock. */
function winningSnapshot(observations: CorpusEntryObservationsV1): Readonly<{
    snapshot: TriageSourceEntrySnapshotV1;
    sortAtMs: number;
}> | null {
    let winner: Readonly<{ snapshot: TriageSourceEntrySnapshotV1; sortAtMs: number; observedAtMs: number }> | null = null;
    for (const observation of observations) {
        if (observation.outcome.kind !== 'present') continue;
        const candidate = {
            snapshot: observation.outcome.snapshot,
            sortAtMs: sortAtMsFor({
                snapshot: observation.outcome.snapshot,
                ...(observation.outcome.sourceUpdatedAtMs === undefined
                    ? {}
                    : { sourceUpdatedAtMs: observation.outcome.sourceUpdatedAtMs }),
                observedAtMs: observation.observedAtMs,
            }),
            observedAtMs: observation.observedAtMs,
        };
        if (winner === null || candidate.observedAtMs > winner.observedAtMs) winner = candidate;
    }
    return winner === null ? null : { snapshot: winner.snapshot, sortAtMs: winner.sortAtMs };
}

function latestObservedAtMs(observations: CorpusEntryObservationsV1): number {
    let latest = 0;
    for (const observation of observations) latest = Math.max(latest, observation.observedAtMs);
    return latest;
}

/**
 * Search folds case with the locale-independent mapping on purpose.
 *
 * `toLocaleLowerCase` reads the device's own locale, so the same query over the
 * same rows would match on one user's machine and not on another's — a Turkish
 * locale maps `I` to `ı`, and a search for `Issue` would then miss every entry
 * titled `ISSUE`. The window is source-neutral and device-local; its matching
 * must not depend on where the device is set up.
 */
function foldForSearch(value: string): string {
    return value.toLowerCase();
}

function matchesQuery(row: TriageListRowV1, query: string): boolean {
    if (query === '') return true;
    const needle = foldForSearch(query);
    for (const observation of row.observations) {
        if (observation.outcome.kind !== 'present') continue;
        const { snapshot, locator } = observation.outcome;
        const haystack = [snapshot.title, snapshot.summary, snapshot.scopeLabel, locator.displayPath];
        for (const value of haystack) {
            if (value !== undefined && foldForSearch(value).includes(needle)) return true;
        }
    }
    return false;
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
        && !filters.sources.some((value) => sameSource(value.source, row.entryRef.source))) {
        return false;
    }
    if (filters.types.length > 0 && !filters.types.some(
        (value) => sameSource(value.source, row.entryRef.source) && value.kindId === row.entryRef.kindId,
    )) {
        return false;
    }
    if (filters.scopes.length > 0 && !filters.scopes.some(
        (value) => sameSource(value.source, row.entryRef.source)
            && value.collisionScope === row.entryRef.collisionScope,
    )) {
        return false;
    }
    return matchesState(row, filters.states) && matchesAttention(row, filters.attention);
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
        const key = entryKey(observation.entryRef);
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
    for (const { entryRef, observations } of grouped.values()) {
        const attention = deriveDisplayedAttention(observations);
        const winner = winningSnapshot(observations);
        const row: TriageListRowV1 = {
            entryRef,
            // An entry with no present observation is not finished; calling it
            // done because a connection failed would retire a live entry.
            lane: winner === null ? CORPUS_LANE.open : laneForSnapshot(winner.snapshot),
            sortAtMs: winner === null ? latestObservedAtMs(observations) : winner.sortAtMs,
            presence: rollUpPresence(observations),
            attention,
            selected: selectObservationInstance(observations, activeSourceInstanceIds, attention, null),
            observations,
        };
        if (matchesFilters(row, input.lens.filters) && matchesQuery(row, input.lens.query)) rows.push(row);
    }

    // Ordering has one owner, and it is not this assembler: `rankCorpusWindow`
    // is the sole comparator for every built-in order, so `smart` cannot drift
    // from the policy a saved view persisted.
    const ordered = rankCorpusWindow(rows, input.lens.order, input.lens.smartPolicy);
    const limit = Math.max(0, Math.min(input.lens.limit, MAX_TRIAGE_LIST_WINDOW_ROWS_V1));
    const bounded = ordered.slice(0, limit);
    const everyLaneExhausted = input.lanes.every((lane) => lane.exhausted);
    const complete = input.configuredSourcesStatus === 'complete'
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
