import { deriveTriageConfiguredSourceInstanceDigestV1 } from '@happier-dev/triage-sources/runtime';
import {
    decodeTriagePagingTokenV1,
    encodeTriagePagingTokenV1,
    TriageScanResultV1Schema,
    TriageListSortV1Schema,
    type TriageListSortV1,
    type TriageScanContinuationV1,
    type TriageScanResultV1,
} from '@happier-dev/triage-protocol/v1';

import type { CorpusQualifiedObservationV1 } from '../corpus/fold/qualify.js';
import type { TriageListLaneV1 } from './listWindow.js';
import type { TriageScanLaneV1, TriageScanPassInputV1, TriageScanPassResultV1, TriageScanPassStopV1 } from './scanPass.js';

type SourcePage = Extract<TriageScanResultV1, { kind: 'page' | 'complete' }>;
type ReadPage = (input: TriageScanPassInputV1, onContractFailure: (sourceInstanceId: string) => void) => Promise<TriageScanPassResultV1>;
type SortedLane = {
    lane: TriageScanLaneV1;
    pageLimit: number;
    queried: boolean;
    page?: SourcePage;
    observations: readonly CorpusQualifiedObservationV1[];
    consumed: number;
    settled: TriageListLaneV1;
    next?: TriageScanContinuationV1;
};

function fieldValue(observation: CorpusQualifiedObservationV1, sort: TriageListSortV1): number | string | undefined {
    if (observation.outcome.kind !== 'present') return undefined;
    const { snapshot, sourceUpdatedAtMs } = observation.outcome;
    switch (sort.field) {
        case 'updated': return sourceUpdatedAtMs;
        case 'created': return snapshot.createdAtMs;
        case 'status': return snapshot.state.nativeLabel;
        case 'repository': return snapshot.scopeLabel;
        case 'due': return snapshot.dueDate;
    }
}

function compareHeads(left: CorpusQualifiedObservationV1, right: CorpusQualifiedObservationV1, sort: TriageListSortV1): number {
    const a = fieldValue(left, sort);
    const b = fieldValue(right, sort);
    // Missing fields stay last in both directions, independently of the id tie.
    if (a === undefined && b !== undefined) return 1;
    if (b === undefined && a !== undefined) return -1;
    if (a !== undefined && b !== undefined && a !== b) return (a < b ? -1 : 1) * (sort.direction === 'asc' ? 1 : -1);
    const leftRef = left.entryRef;
    const rightRef = right.entryRef;
    const leftKey = [leftRef.entryId, leftRef.source.pluginId, leftRef.source.localId, leftRef.kindId, leftRef.collisionScope, left.sourceInstanceId];
    const rightKey = [rightRef.entryId, rightRef.source.pluginId, rightRef.source.localId, rightRef.kindId, rightRef.collisionScope, right.sourceInstanceId];
    for (let index = 0; index < leftKey.length; index += 1) {
        if (leftKey[index] !== rightKey[index]) return leftKey[index]! < rightKey[index]! ? -1 : 1;
    }
    return 0;
}

/**
 * Native pages are already ordered. Merge their heads and retain only the rows
 * not emitted, beside their native cursor in the existing invocation token.
 * Qualification, page contracts, invocation errors and cancellation remain in
 * the ordinary scan owner, which reads exactly one page for this caller.
 */
export async function runTriageFieldSortedScanPass(input: TriageScanPassInputV1, sort: TriageListSortV1, readPage: ReadPage): Promise<TriageScanPassResultV1> {
    const pageLimit = Math.max(1, Math.trunc(input.pageLimit));
    const states: SortedLane[] = input.lanes.map(lane => ({
        lane,
        pageLimit: Math.max(1, Math.trunc(lane.pageLimit ?? Math.max(pageLimit, lane.minimumScanPageSize ?? 1))),
        queried: false,
        observations: [],
        consumed: 0,
        settled: { sourceInstanceId: lane.sourceInstanceId, source: lane.source, health: { kind: 'unavailable' }, exhausted: false },
    }));
    const observations: CorpusQualifiedObservationV1[] = [];
    const contractFailed = new Set<string>();
    const aborted = (): boolean => input.signal?.aborted ?? false;

    async function read(state: SortedLane, resume?: TriageScanContinuationV1, retained?: TriageScanResultV1, observedAtMs?: number): Promise<void> {
        const captured: { page?: TriageScanResultV1 } = {};
        const pass = await readPage({
            ...input,
            ...(observedAtMs === undefined ? {} : { nowMs: () => observedAtMs }),
            lanes: [{ ...state.lane, resume, pageLimit: state.pageLimit, scan: async (request, options) => {
                if (retained !== undefined) {
                    captured.page = retained;
                    return retained;
                }
                state.queried = true;
                const page = await state.lane.scan(request, options);
                captured.page = page;
                return page;
            } }],
            pageLimit: state.pageLimit,
            observationBudget: state.pageLimit,
        }, sourceInstanceId => { contractFailed.add(sourceInstanceId); });
        const page = captured.page;
        state.observations = pass.observations;
        state.consumed = 0;
        state.settled = pass.lanes[0]!;
        state.next = pass.stopped[0]?.continuation;
        state.page = page?.kind === 'page' || page?.kind === 'complete' ? page : undefined;
    }

    await Promise.all(states.map(async state => {
        if (aborted() || input.observationBudget <= 0) return;
        const frontier = state.lane.resume === undefined ? null : decodeTriagePagingTokenV1(state.lane.resume.token);
        if (frontier?.kind !== 'triage-field-sort') {
            await read(state, state.lane.resume);
            return;
        }
        const page = TriageScanResultV1Schema.safeParse(frontier.page);
        const retainedSort = TriageListSortV1Schema.safeParse(frontier.sort);
        const sameInstance = frontier.instanceDigest === deriveTriageConfiguredSourceInstanceDigestV1(state.lane.configured);
        const sameSort = retainedSort.success && retainedSort.data.field === sort.field && retainedSort.data.direction === sort.direction;
        const observedAtMs = frontier.observedAtMs;
        const validClock = typeof observedAtMs === 'number' && Number.isInteger(observedAtMs) && observedAtMs >= 0;
        await read(state, undefined, sameInstance && sameSort && validClock && page.success && page.data.kind !== 'failed' ? page.data : {
            kind: 'failed', failure: { class: 'unsupportedContract', code: 'triage/invalidSortContinuation' },
        }, validClock ? observedAtMs : undefined);
    }));

    let blocked = false;
    while (!aborted() && observations.length < input.observationBudget) {
        // A retained page can empty before this invocation reads its source.
        // Read at most one native page per source, including sparse pages.
        await Promise.all(states.filter(state => state.consumed === state.observations.length
            && state.next !== undefined && !state.queried).map(state => read(state, state.next)));
        if (aborted()) break;
        // Without an unfinished source's head, no other head is known to be
        // next. A healthy advancing empty page can resume; errors cannot.
        const missing = states.filter(state => state.consumed === state.observations.length && !state.settled.exhausted);
        if (missing.some(state => state.next === undefined)) {
            blocked = true;
            break;
        }
        if (missing.length > 0) break;
        let next: SortedLane | undefined;
        for (const state of states) {
            const head = state.observations[state.consumed];
            if (head !== undefined && (next === undefined || compareHeads(head, next.observations[next.consumed]!, sort) < 0)) next = state;
        }
        if (next === undefined) break;
        observations.push(next.observations[next.consumed]!);
        next.consumed += 1;
    }

    // The last emitted row can empty an unfinished lane exactly at the result
    // boundary. It still cannot disappear from a later sorted continuation.
    blocked ||= states.some(state => state.consumed === state.observations.length
        && !state.settled.exhausted && state.next === undefined);
    let overflow = false;
    const stopped: TriageScanPassStopV1[] = [];
    if (!aborted() && !blocked) for (const state of states) {
        const remaining = state.observations.length - state.consumed;
        if (remaining === 0) {
            if (state.next !== undefined) stopped.push({ sourceInstanceId: state.lane.sourceInstanceId, pageLimit: state.pageLimit, continuation: state.next });
            continue;
        }
        // Keep source-private currentness and locator fields exactly as read.
        // The canonical source-result schema parses this page when resumed;
        // no hand-authored copy of its observation grammar lives here.
        const selected = state.lane.selectedKindIds;
        const page = state.page!;
        const pendingPage = { ...page, observations: page.observations
            .filter(observation => selected === undefined || selected.includes(observation.localRef.kindId))
            .slice(state.consumed) };
        const token = encodeTriagePagingTokenV1({ kind: 'triage-field-sort', instanceDigest: deriveTriageConfiguredSourceInstanceDigestV1(state.lane.configured), sort, observedAtMs: state.observations[0]!.observedAtMs, page: pendingPage });
        if (token === null) {
            overflow = true;
            state.settled = { ...state.settled, exhausted: false, health: {
                ...(state.settled.health.kind === 'partial' ? state.settled.health : {}),
                kind: 'partial', reason: 'continuation-unavailable',
            } };
        } else stopped.push({ sourceInstanceId: state.lane.sourceInstanceId, pageLimit: state.pageLimit, continuation: { v: 1, token } });
    }

    return Object.freeze({
        observationBudget: input.observationBudget,
        observations: Object.freeze(observations.filter(observation => !contractFailed.has(observation.sourceInstanceId))),
        lanes: Object.freeze(states.map(state => Object.freeze({ ...state.settled, exhausted: state.settled.exhausted && state.consumed === state.observations.length }))),
        // Omitting one failing/overflowed lane would silently lose its rows on
        // later pages. Settle the whole sorted walk as visibly incomplete.
        stopped: Object.freeze(aborted() || blocked || overflow ? [] : stopped.map(stop => Object.freeze(stop))),
    });
}
