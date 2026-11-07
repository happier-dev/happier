import { TriageConfiguredSourceInstanceV1Schema, type TriageScanResultV1 } from '@happier-dev/triage-protocol/v1';
import { describe, expect, it, vi } from 'vitest';
import { PluginError } from '@happier-dev/plugin-sdk';

import {
    testkitLocator,
    testkitSnapshot,
    testkitViewer,
} from '../corpus/testkit/observations.test-support.js';
import { runTriageScanPass, type TriageScanLaneV1 } from './scanPass.js';

/**
 * A page is qualified atomically.
 *
 * The falsifier this file exists for is the salvaging pass: one that qualifies
 * each returned observation on its own, drops the ones it rejects, and then
 * adopts the page's evidence and the survivors. That pass publishes a healthy
 * `walkFinished` lane, and a list the user reads as complete, for a source
 * whose contribution is not conforming — so the defect is invisible exactly
 * where it matters.
 */

const SOURCE = Object.freeze({ pluginId: 'happier.example.source', localId: 'example-forge' });
const INSTANCE_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_INSTANCE_ID = '22222222-2222-4222-8222-222222222222';

function configured(sourceInstanceId: string) {
    return TriageConfiguredSourceInstanceV1Schema.parse({
        v: 1,
        instance: { source: SOURCE, sourceInstanceId },
        binding: {
            purpose: 'triage-source',
            account: { service: { pluginId: SOURCE.pluginId, localId: 'accounts' }, accountId: 'account-1' },
        },
        localInstanceKey: 'example/repository',
        configuration: { v: 1, token: 'routing-token' },
    });
}

function presentObservation(kindId: string, entryId: string) {
    return {
        kind: 'present',
        localRef: { kindId, collisionScope: 'example/repository', entryId },
        locator: testkitLocator(),
        snapshot: testkitSnapshot(),
        viewer: testkitViewer(),
    } as const;
}

/**
 * A lane whose pages are chosen from the continuation the pass submitted, so a
 * test can script a source that either ADVANCES its position or hands the same
 * one back. The distinction is the whole subject of the non-progress guard, and
 * a fixture that ignores its input cannot express it.
 */
function positionalLane(input: Readonly<{
    sourceInstanceId: string;
    declaredKindIds: readonly string[];
    /** Keyed by the submitted continuation token; `null` is the initial page. */
    pageFor: (token: string | null) => TriageScanResultV1;
}>): TriageScanLaneV1 {
    return {
        sourceInstanceId: input.sourceInstanceId,
        source: SOURCE,
        declaredKindIds: input.declaredKindIds,
        configured: configured(input.sourceInstanceId),
        scan: async (scanInput) => input.pageFor(
            scanInput.page.kind === 'continuation' ? scanInput.page.continuation.token : null,
        ),
    };
}

function lane(input: Readonly<{
    sourceInstanceId: string;
    declaredKindIds: readonly string[];
    pages: readonly TriageScanResultV1[];
    /** Records the order the pass asked its lanes in, when a test cares. */
    calls?: string[];
}>): TriageScanLaneV1 {
    let index = 0;
    return {
        sourceInstanceId: input.sourceInstanceId,
        source: SOURCE,
        declaredKindIds: input.declaredKindIds,
        configured: configured(input.sourceInstanceId),
        scan: async () => {
            input.calls?.push(input.sourceInstanceId);
            const page = input.pages[index];
            index += 1;
            if (page === undefined) throw new Error('the pass asked for a page the lane never offered');
            return page;
        },
    };
}

/** One never-ending lane: every page offers a continuation. */
function endlessPages(kindId: string, count: number): readonly TriageScanResultV1[] {
    return Array.from({ length: count }, (_unused, index) => ({
        kind: 'page',
        evidence: { kind: 'partial', reason: 'pageLimit' },
        observations: [presentObservation(kindId, `deep-${String(index)}`)],
        continuation: { v: 1, token: `next-${String(index)}` },
    } as unknown as TriageScanResultV1));
}

const WALK_FINISHED = { kind: 'walkFinished' } as const;

/**
 * One lane whose pages are supplied by an explicit answer function, so a test
 * can make a page stall, settle late, or observe the signal it was given.
 */
function answeringLane(input: Readonly<{
    sourceInstanceId: string;
    declaredKindIds: readonly string[];
    scan: TriageScanLaneV1['scan'];
}>): TriageScanLaneV1 {
    return {
        sourceInstanceId: input.sourceInstanceId,
        source: SOURCE,
        declaredKindIds: input.declaredKindIds,
        configured: configured(input.sourceInstanceId),
        scan: input.scan,
    };
}

function completedPage(entryId: string): TriageScanResultV1 {
    return {
        kind: 'complete',
        evidence: WALK_FINISHED,
        observations: [presentObservation('pull-request', entryId)],
    } as unknown as TriageScanResultV1;
}

describe('one materialization pass', () => {
    it.each([
        { observationBudget: 1, rowCount: 10 },
        { observationBudget: 4, rowCount: 2 },
    ])('admits one native minimum page with a smaller $observationBudget-row share', async ({ observationBudget, rowCount }) => {
        const submitted: number[] = [];
        const source = {
            ...answeringLane({ sourceInstanceId: INSTANCE_ID, declaredKindIds: ['issue'], scan: async input => {
                if (input.page.kind !== 'initial') throw new Error('The native page must remain explicit continuation demand');
                submitted.push(input.page.limit);
                return { kind: 'page', observations: Array.from({ length: rowCount }, (_, index) => presentObservation('issue', String(index))),
                    evidence: { kind: 'partial', reason: 'more-pages' }, continuation: { v: 1, token: 'native-next' } };
            } }),
            minimumScanPageSize: 10,
        };
        const result = await runTriageScanPass({ lanes: [source], pageLimit: observationBudget,
            observationBudget, nowMs: () => 1000 });

        expect(submitted).toEqual([10]);
        expect(result.observations).toHaveLength(rowCount);
        expect(result.lanes[0]).toMatchObject({ exhausted: false, health: { kind: 'partial' } });
        expect(result.stopped).toEqual([{ sourceInstanceId: INSTANCE_ID, pageLimit: 10,
            continuation: { v: 1, token: 'native-next' } }]);
    });

    it('spends one source page for text search and keeps its continuation as partial', async () => {
        const calls: string[] = [];
        const source = { ...answeringLane({ sourceInstanceId: INSTANCE_ID, declaredKindIds: ['issue'], scan: async input => {
            calls.push('query' in input && typeof input.query === 'string' ? input.query : '');
            return { kind: 'page', observations: [presentObservation('issue', 'match')],
                evidence: { kind: 'partial', reason: 'more-pages' }, continuation: { v: 1, token: `next-${calls.length}` } };
        } }), query: 'needle' };
        const result = await runTriageScanPass({ lanes: [source], pageLimit: 8, observationBudget: 8, nowMs: () => 1_000 });
        expect(calls).toEqual(['needle']);
        expect(result.lanes[0]).toMatchObject({ exhausted: false, health: { kind: 'partial' } });
        expect(result.stopped).toMatchObject([{ sourceInstanceId: INSTANCE_ID, continuation: { token: 'next-1' } }]);
        expect(result.observations).toHaveLength(1);
    });

    it('walks advancing pages without scheduling an aggregate yield timer', async () => {
        const timer = vi.spyOn(globalThis, 'setTimeout');
        try {
            const pass = await runTriageScanPass({
                lanes: [lane({ sourceInstanceId: INSTANCE_ID, declaredKindIds: ['issue'], pages: [
                    { kind: 'page', evidence: { kind: 'partial', reason: 'pageLimit' },
                        observations: [presentObservation('issue', 'one')], continuation: { v: 1, token: 'two' } },
                    { kind: 'page', evidence: { kind: 'partial', reason: 'pageLimit' },
                        observations: [presentObservation('issue', 'two')], continuation: { v: 1, token: 'three' } },
                    { kind: 'complete', evidence: WALK_FINISHED, observations: [presentObservation('issue', 'three')] },
                ] })],
                pageLimit: 1, observationBudget: 3, nowMs: () => 1000,
            });
            expect(pass.observations.map(item => item.entryRef.entryId)).toEqual(['one', 'two', 'three']);
            expect(pass.lanes[0]?.exhausted).toBe(true);
            expect(timer).not.toHaveBeenCalled();
        } finally {
            timer.mockRestore();
        }
    });

    it('walks past non-selected kinds before spending the result row budget', async () => {
        const mixed = positionalLane({
            sourceInstanceId: INSTANCE_ID,
            declaredKindIds: ['pull-request', 'issue'],
            pageFor: (token) => token === null ? {
                kind: 'page', evidence: { kind: 'partial', reason: 'pageLimit' },
                observations: [presentObservation('pull-request', 'pr')],
                continuation: { v: 1, token: 'tasks-page' },
            } : {
                kind: 'complete', evidence: WALK_FINISHED,
                observations: [presentObservation('issue', 'task')],
            },
        });
        const pass = await runTriageScanPass({
            lanes: [{ ...mixed, selectedKindIds: ['issue'] }],
            pageLimit: 1, observationBudget: 1, nowMs: () => 1000,
        });
        expect(pass.observations.map((item) => item.entryRef.entryId)).toEqual(['task']);
        expect(pass.lanes[0]?.exhausted).toBe(true);
        expect(pass.stopped).toEqual([]);
    });

    it('still rejects an undeclared kind even when it would be filtered from the result', async () => {
        const source = positionalLane({
            sourceInstanceId: INSTANCE_ID, declaredKindIds: ['issue'],
            pageFor: () => ({ kind: 'complete', evidence: WALK_FINISHED,
                observations: [presentObservation('undeclared', 'bad')] }),
        });
        const pass = await runTriageScanPass({
            lanes: [{ ...source, selectedKindIds: ['issue'] }],
            pageLimit: 1, observationBudget: 1, nowMs: () => 1000,
        });
        expect(pass.observations).toEqual([]);
        expect(pass.lanes[0]?.health.kind).toBe('failed');
    });

    it.each([
        { error: new PluginError({ code: 'source_read_refused', retryable: true, message: 'private exception' }),
            expected: { code: 'source_read_refused', retryable: true } },
        // Ordinary separately bundled SDK errors share the public contract, not a constructor.
        { error: Object.assign(new Error('private exception'), {
            name: 'PluginError', code: 'external_source_refused', retryable: false,
            data: { name: 'PluginError', code: 'external_source_refused', retryable: false, message: 'private exception' },
        }), expected: { code: 'external_source_refused', retryable: false } },
        { error: new Error('private exception'), expected: { code: 'triage/scanInvocationRejected' } },
    ])('keeps only safe rejection diagnostics for an unavailable source', async ({ error, expected }) => {
        const warn = vi.fn();
        const pass = await runTriageScanPass({
            lanes: [answeringLane({ sourceInstanceId: INSTANCE_ID, declaredKindIds: ['pull-request'],
                scan: () => { throw error; },
            })],
            pageLimit: 1, observationBudget: 1, nowMs: () => 1000,
            logger: { warn },
        });
        expect(pass.lanes[0]?.health).toEqual({ kind: 'unavailable', error: expected });
        expect(warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining(expected));
        expect(JSON.stringify([pass, warn.mock.calls])).not.toContain('private exception');
    });

    it('rejects a whole page whose source broke the contract, and adopts none of its siblings', async () => {
        const pass = await runTriageScanPass({
            lanes: [lane({
                sourceInstanceId: INSTANCE_ID,
                declaredKindIds: ['pull-request'],
                pages: [{
                    kind: 'complete',
                    evidence: WALK_FINISHED,
                    observations: [
                        presentObservation('pull-request', '17'),
                        // The source's own descriptor never declared `issue`.
                        presentObservation('issue', '18'),
                        presentObservation('pull-request', '19'),
                    ],
                } as unknown as TriageScanResultV1],
            })],
            pageLimit: 16,
            observationBudget: 64,
            nowMs: () => 1_000,
        });

        expect(pass.observations).toEqual([]);
        expect(pass.lanes).toHaveLength(1);
        expect(pass.lanes[0]?.health).toEqual({
            kind: 'failed',
            failure: {
                class: 'unsupportedContract',
                code: 'triage/undeclaredKind',
                detail: 'The source returned a page that does not satisfy the V1 observation contract.',
            },
        });
        // A contract-failed lane never claims a settled end of its walk.
        expect(pass.lanes[0]?.exhausted).toBe(false);
    });

    it('reaches a terminal row beyond the former empty-page depth wall', async () => {
        const pass = await runTriageScanPass({
            lanes: [lane({
                sourceInstanceId: INSTANCE_ID,
                declaredKindIds: ['pull-request'],
                pages: [
                    {
                        kind: 'page',
                        evidence: { kind: 'moving', reason: 'live-order' },
                        observations: [presentObservation('pull-request', '17')],
                        continuation: { v: 1, token: 'next' },
                    } as unknown as TriageScanResultV1,
                    ...Array.from({ length: 200 }, (_unused, index) => ({
                        kind: 'page',
                        evidence: { kind: 'partial', reason: 'undecodable-items', omittedItemCount: 0 },
                        observations: [],
                        continuation: { v: 1, token: `next-${String(index)}` },
                    } as unknown as TriageScanResultV1)),
                    completedPage('after-empty-containers'),
                ],
            })],
            pageLimit: 16,
            observationBudget: 64,
            nowMs: () => 1_000,
        });

        expect(pass.observations.map((observation) => observation.entryRef.entryId))
            .toEqual(['17', 'after-empty-containers']);
        expect(pass.lanes[0]?.health).toEqual(WALK_FINISHED);
        expect(pass.lanes[0]?.exhausted).toBe(true);
    });


    it('drops every earlier page of the lane that later broke the contract', async () => {
        const pass = await runTriageScanPass({
            lanes: [lane({
                sourceInstanceId: INSTANCE_ID,
                declaredKindIds: ['pull-request'],
                pages: [
                    {
                        kind: 'page',
                        evidence: WALK_FINISHED,
                        observations: [presentObservation('pull-request', '17')],
                        continuation: { v: 1, token: 'next' },
                    } as unknown as TriageScanResultV1,
                    {
                        kind: 'complete',
                        evidence: WALK_FINISHED,
                        observations: [presentObservation('issue', '18')],
                    } as unknown as TriageScanResultV1,
                ],
            })],
            pageLimit: 16,
            observationBudget: 64,
            nowMs: () => 1_000,
        });

        expect(pass.observations).toEqual([]);
        expect(pass.lanes[0]?.health).toMatchObject({ kind: 'failed' });
    });

    it('leaves every other lane exactly as it answered', async () => {
        const pass = await runTriageScanPass({
            lanes: [
                lane({
                    sourceInstanceId: INSTANCE_ID,
                    declaredKindIds: ['pull-request'],
                    pages: [{
                        kind: 'complete',
                        evidence: WALK_FINISHED,
                        observations: [presentObservation('issue', '18')],
                    } as unknown as TriageScanResultV1],
                }),
                lane({
                    sourceInstanceId: OTHER_INSTANCE_ID,
                    declaredKindIds: ['pull-request'],
                    pages: [{
                        kind: 'complete',
                        evidence: WALK_FINISHED,
                        observations: [presentObservation('pull-request', '21')],
                    } as unknown as TriageScanResultV1],
                }),
            ],
            pageLimit: 16,
            observationBudget: 64,
            nowMs: () => 1_000,
        });

        expect(pass.observations.map((observation) => observation.sourceInstanceId))
            .toEqual([OTHER_INSTANCE_ID]);
        expect(pass.lanes.map((entry) => entry.health.kind)).toEqual(['failed', 'walkFinished']);
        expect(pass.lanes.map((entry) => entry.exhausted)).toEqual([false, true]);
    });

    it('adopts a conforming page whole', async () => {
        const pass = await runTriageScanPass({
            lanes: [lane({
                sourceInstanceId: INSTANCE_ID,
                declaredKindIds: ['pull-request'],
                pages: [{
                    kind: 'complete',
                    evidence: WALK_FINISHED,
                    observations: [
                        presentObservation('pull-request', '17'),
                        presentObservation('pull-request', '19'),
                    ],
                } as unknown as TriageScanResultV1],
            })],
            pageLimit: 16,
            observationBudget: 64,
            nowMs: () => 1_000,
        });

        expect(pass.observations.map((observation) => observation.entryRef.entryId)).toEqual(['17', '19']);
        expect(pass.lanes[0]?.health).toEqual(WALK_FINISHED);
        expect(pass.lanes[0]?.exhausted).toBe(true);
    });
    /**
     * `core/CORPUS.md` §4.3 and §4.7. A sequential drain reads one lane to its
     * end before touching the next, so a deep source consumes the whole budget
     * and a shallow one is never asked at all — which reads as a missing
     * integration rather than as a paging choice, and which no lane health arm
     * reports because the deep lane genuinely answered.
     */
    it('gives every source lane a bounded slice before any lane takes a second one', async () => {
        const calls: string[] = [];
        const pass = await runTriageScanPass({
            lanes: [
                lane({
                    sourceInstanceId: INSTANCE_ID,
                    declaredKindIds: ['pull-request'],
                    pages: endlessPages('pull-request', 8),
                    calls,
                }),
                lane({
                    sourceInstanceId: OTHER_INSTANCE_ID,
                    declaredKindIds: ['pull-request'],
                    pages: [{
                        kind: 'complete',
                        evidence: WALK_FINISHED,
                        observations: [presentObservation('pull-request', 'shallow')],
                    } as unknown as TriageScanResultV1],
                    calls,
                }),
            ],
            pageLimit: 1,
            observationBudget: 4,
            nowMs: () => 1_000,
        });

        // The shallow lane is asked before the deep one takes a second page.
        expect(calls.slice(0, 2)).toEqual([INSTANCE_ID, OTHER_INSTANCE_ID]);
        expect(pass.observations.map((observation) => observation.sourceInstanceId))
            .toContain(OTHER_INSTANCE_ID);
        expect(pass.lanes.map((entry) => entry.exhausted)).toEqual([false, true]);
    });

    it('advances healthy lanes serially while an earlier lane is still unanswered', async () => {
        vi.useFakeTimers();
        const calls: string[] = [];
        let releaseSlow!: (page: TriageScanResultV1) => void;
        let releaseHealthy!: (page: TriageScanResultV1) => void;
        const slow = new Promise<TriageScanResultV1>((resolve) => { releaseSlow = resolve; });
        const healthy = new Promise<TriageScanResultV1>((resolve) => { releaseHealthy = resolve; });
        const pending = runTriageScanPass({
            lanes: [
                answeringLane({ sourceInstanceId: INSTANCE_ID, declaredKindIds: ['pull-request'],
                    scan: () => { calls.push('slow'); return slow; } }),
                answeringLane({ sourceInstanceId: OTHER_INSTANCE_ID, declaredKindIds: ['pull-request'],
                    scan: async (input) => {
                        calls.push(input.page.kind === 'initial' ? 'healthy-first' : input.page.continuation.token);
                        return input.page.kind === 'initial' ? await healthy : completedPage('healthy-last');
                    } }),
            ],
            pageLimit: 1, observationBudget: 3, nowMs: () => 1_000,
        });
        try {
            expect(calls).toEqual(['slow', 'healthy-first']);
            // Neither pending page can cause another read of its own lane.
            await vi.runAllTimersAsync();
            expect(calls).toEqual(['slow', 'healthy-first']);
            releaseHealthy({ kind: 'page', evidence: { kind: 'partial', reason: 'pageLimit' },
                observations: [presentObservation('pull-request', 'healthy-first')],
                continuation: { v: 1, token: 'healthy-next' } });
            await vi.runAllTimersAsync();
            expect(calls).toEqual(['slow', 'healthy-first', 'healthy-next']);
        } finally {
            releaseHealthy(completedPage('healthy-first'));
            releaseSlow(completedPage('slow'));
            await vi.runAllTimersAsync();
            await pending;
            vi.useRealTimers();
        }
        const pass = await pending;
        expect(pass.observations.map((observation) => observation.entryRef.entryId).sort())
            .toEqual(['healthy-first', 'healthy-last', 'slow']);
        expect(pass.lanes.every((entry) => entry.exhausted)).toBe(true);
    });

    it('reserves whole pending pages and gives waiting lanes the next available budget', async () => {
        vi.useFakeTimers();
        const calls: string[] = [];
        const thirdId = '33333333-3333-4333-8333-333333333333';
        let releaseSlow!: (page: TriageScanResultV1) => void;
        const slow = new Promise<TriageScanResultV1>((resolve) => { releaseSlow = resolve; });
        const pending = runTriageScanPass({
            lanes: [
                answeringLane({ sourceInstanceId: INSTANCE_ID, declaredKindIds: ['pull-request'],
                    scan: () => { calls.push(INSTANCE_ID); return slow; } }),
                lane({ sourceInstanceId: OTHER_INSTANCE_ID, declaredKindIds: ['pull-request'],
                    pages: endlessPages('pull-request', 3), calls }),
                lane({ sourceInstanceId: thirdId, declaredKindIds: ['pull-request'],
                    pages: [completedPage('third')], calls }),
            ],
            pageLimit: 1, observationBudget: 2, nowMs: () => 1_000,
        });
        try {
            await vi.runAllTimersAsync();
            expect(calls).toEqual([INSTANCE_ID, OTHER_INSTANCE_ID]);
            // The first pending page still owns one row of capacity. Once it
            // answers empty, the untouched third lane precedes a second slice.
            releaseSlow({ kind: 'complete', evidence: WALK_FINISHED, observations: [] });
            await vi.runAllTimersAsync();
            const pass = await pending;
            expect(calls).toEqual([INSTANCE_ID, OTHER_INSTANCE_ID, thirdId]);
            expect(pass.observations.map((observation) => observation.entryRef.entryId))
                .toEqual(['deep-0', 'third']);
            expect(pass.stopped.map((entry) => entry.sourceInstanceId)).toEqual([OTHER_INSTANCE_ID]);
        } finally {
            releaseSlow({ kind: 'complete', evidence: WALK_FINISHED, observations: [] });
            await vi.runAllTimersAsync();
            await pending;
            vi.useRealTimers();
        }
    });

    it('shares caller cancellation across in-flight lanes without starting continuations', async () => {
        const controller = new AbortController();
        const signals: AbortSignal[] = [];
        const pending = runTriageScanPass({
            lanes: [INSTANCE_ID, OTHER_INSTANCE_ID].map((sourceInstanceId) => answeringLane({
                sourceInstanceId, declaredKindIds: ['pull-request'],
                scan: (_input, options) => new Promise<TriageScanResultV1>((_resolve, reject) => {
                    if (options?.signal) {
                        signals.push(options.signal);
                        options.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
                    }
                }),
            })),
            signal: controller.signal,
            pageLimit: 1, observationBudget: 4, nowMs: () => 1_000,
        });
        try {
            expect(signals).toHaveLength(2);
        } finally {
            controller.abort();
            await pending;
        }
        const pass = await pending;
        expect(signals.every((signal) => signal.aborted)).toBe(true);
        expect(signals).toHaveLength(2);
        expect(pass.observations).toEqual([]);
        expect(pass.lanes.every((entry) => !entry.exhausted)).toBe(true);
        expect(pass.stopped).toEqual([]);
    });

    it('keeps caller cancellation through body completion and adopts no late page', async () => {
        const controller = new AbortController();
        let completeBody!: (page: TriageScanResultV1) => void;
        let providerSignal: AbortSignal | undefined;
        const pending = runTriageScanPass({
            lanes: [answeringLane({
                sourceInstanceId: INSTANCE_ID,
                declaredKindIds: ['pull-request'],
                // The transport already has headers; cancellation happens while
                // its body is held, and the body may still settle afterwards.
                scan: (_input, options) => {
                    providerSignal = options?.signal;
                    return new Promise((resolve) => { completeBody = resolve; });
                },
            })],
            signal: controller.signal,
            pageLimit: 1, observationBudget: 4, nowMs: () => 1_000,
        });
        expect(providerSignal?.aborted).toBe(false);
        controller.abort();
        expect(providerSignal?.aborted).toBe(true);
        completeBody(completedPage('late-body'));
        const pass = await pending;
        expect(pass.observations).toEqual([]);
        expect(pass.lanes[0]?.exhausted).toBe(false);
        expect(pass.stopped).toEqual([]);
    });

    it('retains admitted pages when caller cancellation stops an unanswered continuation', async () => {
        const controller = new AbortController();
        let continuationStarted!: () => void;
        const started = new Promise<void>((resolve) => { continuationStarted = resolve; });
        let calls = 0;
        const pending = runTriageScanPass({
            lanes: [answeringLane({
                sourceInstanceId: INSTANCE_ID, declaredKindIds: ['pull-request'],
                scan: async (_input, options) => {
                    calls += 1;
                    if (calls === 1) return {
                        kind: 'page', evidence: { kind: 'partial', reason: 'pageLimit' },
                        observations: [presentObservation('pull-request', 'retained')],
                        continuation: { v: 1, token: 'next' },
                    };
                    return new Promise<TriageScanResultV1>((_resolve, reject) => {
                        options?.signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
                        continuationStarted();
                    });
                },
            })],
            signal: controller.signal,
            pageLimit: 1, observationBudget: 4, nowMs: () => 1_000,
        });
        await started;
        controller.abort();
        const pass = await pending;
        expect(calls).toBe(2);
        expect(pass.observations.map((observation) => observation.entryRef.entryId)).toEqual(['retained']);
        expect(pass.lanes[0]?.exhausted).toBe(false);
        expect(pass.stopped).toEqual([]);
    });

    it('ends the rotation rather than the lane when the observation budget runs out', async () => {
        const pass = await runTriageScanPass({
            lanes: [lane({
                sourceInstanceId: INSTANCE_ID,
                declaredKindIds: ['pull-request'],
                pages: endlessPages('pull-request', 8),
            })],
            pageLimit: 1,
            observationBudget: 3,
            nowMs: () => 1_000,
        });

        expect(pass.observations).toHaveLength(3);
        // An unexhausted lane keeps `exhausted: false`, so the window it feeds
        // reports a resumable partial rather than a healthy empty one.
        expect(pass.lanes[0]?.exhausted).toBe(false);
        expect(pass.lanes[0]?.health).toEqual({ kind: 'partial', reason: 'pageLimit' });
    });

    /**
     * Capacity is reserved before asking for a whole page, never while the
     * answer is adopted. A short page releases unused capacity, but that does
     * not authorize fetching a later atomic page whose limit cannot fit.
     * Its frontier remains explicit Load More demand, so no provider cursor
     * advances past rows the aggregate result cannot carry.
     */
    it('leaves a page behind its frontier when the remaining budget cannot carry it whole', async () => {
        const shortPage = (page: number): TriageScanResultV1 => ({
            kind: 'page',
            evidence: { kind: 'partial', reason: 'pageLimit' },
            observations: [0, 1, 2].map(
                (row) => presentObservation('pull-request', `short-${String(page)}-${String(row)}`),
            ),
            continuation: { v: 1, token: `next-${String(page)}` },
        } as unknown as TriageScanResultV1);

        const pass = await runTriageScanPass({
            lanes: [lane({
                sourceInstanceId: INSTANCE_ID,
                declaredKindIds: ['pull-request'],
                pages: [shortPage(0), shortPage(1), shortPage(2)],
            })],
            pageLimit: 4,
            observationBudget: 4,
            nowMs: () => 1_000,
        });

        // The first page is admitted whole. The second is not fetched because
        // only one row of budget remains and advancing past a three-row provider
        // page would strand its other two rows behind the returned frontier.
        expect(pass.observations).toHaveLength(3);
        expect(pass.lanes[0]?.exhausted).toBe(false);
        expect(pass.stopped).toHaveLength(1);
    });

    it('drops a failed lane from the rotation without ending the page', async () => {
        const pass = await runTriageScanPass({
            lanes: [
                lane({
                    sourceInstanceId: INSTANCE_ID,
                    declaredKindIds: ['pull-request'],
                    pages: [{
                        kind: 'failed',
                        failure: { class: 'permission', code: 'forbidden' },
                    } as unknown as TriageScanResultV1],
                }),
                lane({
                    sourceInstanceId: OTHER_INSTANCE_ID,
                    declaredKindIds: ['pull-request'],
                    pages: [
                        {
                            kind: 'page',
                            evidence: { kind: 'partial', reason: 'pageLimit' },
                            observations: [presentObservation('pull-request', '21')],
                            continuation: { v: 1, token: 'next' },
                        } as unknown as TriageScanResultV1,
                        {
                            kind: 'complete',
                            evidence: WALK_FINISHED,
                            observations: [presentObservation('pull-request', '22')],
                        } as unknown as TriageScanResultV1,
                    ],
                }),
            ],
            pageLimit: 4,
            observationBudget: 64,
            nowMs: () => 1_000,
        });

        expect(pass.observations.map((observation) => observation.entryRef.entryId)).toEqual(['21', '22']);
        expect(pass.lanes.map((entry) => entry.health.kind)).toEqual(['failed', 'walkFinished']);
    });

    /**
     * `CONTRACT.md` §5.1. The published schema can only enforce the global
     * ceiling, so the *contextual* limit this pass actually submitted has no
     * enforcement anywhere unless the target checks it: a source whose budget
     * accounting drifts overfills the page, and the list adopts more rows than
     * it asked for with nothing to error on.
     */
    it('rejects a whole page that carries more than the limit it was asked for', async () => {
        const pass = await runTriageScanPass({
            lanes: [
                lane({
                    sourceInstanceId: INSTANCE_ID,
                    declaredKindIds: ['pull-request'],
                    pages: [{
                        kind: 'complete',
                        // Two mapped rows plus two omitted ones is four charged
                        // against a submitted limit of three.
                        evidence: { kind: 'partial', reason: 'undecodable-items', omittedItemCount: 2 },
                        observations: [
                            presentObservation('pull-request', '17'),
                            presentObservation('pull-request', '19'),
                        ],
                    } as unknown as TriageScanResultV1],
                }),
                lane({
                    sourceInstanceId: OTHER_INSTANCE_ID,
                    declaredKindIds: ['pull-request'],
                    pages: [completedPage('21')],
                }),
            ],
            pageLimit: 3,
            observationBudget: 64,
            nowMs: () => 1_000,
        });

        // A breach is a whole-lane source-contract failure, not partially valid
        // data: nothing is truncated and nothing is silently dropped.
        expect(pass.observations.map((observation) => observation.entryRef.entryId)).toEqual(['21']);
        expect(pass.lanes[0]?.health).toEqual({
            kind: 'failed',
            failure: {
                class: 'unsupportedContract',
                code: 'triage/pageLimitExceeded',
                detail: expect.any(String),
            },
        });
        expect(pass.lanes[0]?.exhausted).toBe(false);
    });

    it('adopts a page that exactly fills the limit it was asked for', async () => {
        const pass = await runTriageScanPass({
            lanes: [lane({
                sourceInstanceId: INSTANCE_ID,
                declaredKindIds: ['pull-request'],
                pages: [{
                    kind: 'complete',
                    evidence: { kind: 'partial', reason: 'undecodable-items', omittedItemCount: 1 },
                    observations: [
                        presentObservation('pull-request', '17'),
                        presentObservation('pull-request', '19'),
                    ],
                } as unknown as TriageScanResultV1],
            })],
            pageLimit: 3,
            observationBudget: 64,
            nowMs: () => 1_000,
        });

        expect(pass.observations.map((observation) => observation.entryRef.entryId)).toEqual(['17', '19']);
        expect(pass.lanes[0]?.health).toEqual({
            kind: 'partial',
            reason: 'undecodable-items',
            omittedItemCount: 1,
        });
        // Adopted, and still not a finished walk: the page omitted a row, which
        // is what its own evidence says. See the exhaustion contract below.
        expect(pass.lanes[0]?.exhausted).toBe(false);
    });

    /**
     * Exhaustion is the one member `projection/listWindow.ts` derives
     * `coverage` from, so it has to mean what it says: this lane's walk ran out
     * of pages AND enumerated its set.
     *
     * The falsifier these three exist for is a pass that reads only
     * `result.kind`. `complete` says the source stopped paging; the evidence on
     * the same page says whether it finished. Conflating them published a
     * provider-truncated inbox as `coverage: 'complete'`, and the mounted
     * store's exhausted-replaces branch — correct once exhaustion is truthful —
     * then deleted every retained row that truncated page did not name.
     */
    it('claims exhaustion only for a settled walk whose own evidence finished it', async () => {
        const pass = await runTriageScanPass({
            lanes: [lane({
                sourceInstanceId: INSTANCE_ID,
                declaredKindIds: ['pull-request'],
                pages: [completedPage('17')],
            })],
            pageLimit: 16,
            observationBudget: 64,
            nowMs: () => 1_000,
        });

        expect(pass.lanes[0]?.exhausted).toBe(true);
    });

    it('never claims exhaustion for a settled walk whose evidence is partial', async () => {
        const pass = await runTriageScanPass({
            lanes: [lane({
                sourceInstanceId: INSTANCE_ID,
                declaredKindIds: ['pull-request'],
                pages: [{
                    kind: 'complete',
                    evidence: { kind: 'partial', reason: 'result-ceiling' },
                    observations: [presentObservation('pull-request', '17')],
                } as unknown as TriageScanResultV1],
            })],
            pageLimit: 16,
            observationBudget: 64,
            nowMs: () => 1_000,
        });

        // The rows are adopted — a truncated walk still answered for what it
        // reached — but the lane may not claim it enumerated its set.
        expect(pass.observations.map((observation) => observation.entryRef.entryId)).toEqual(['17']);
        expect(pass.lanes[0]?.health).toEqual({ kind: 'partial', reason: 'result-ceiling' });
        expect(pass.lanes[0]?.exhausted).toBe(false);
    });

    it('never claims exhaustion for a settled walk whose set was moving underneath it', async () => {
        const pass = await runTriageScanPass({
            lanes: [lane({
                sourceInstanceId: INSTANCE_ID,
                declaredKindIds: ['pull-request'],
                pages: [{
                    kind: 'complete',
                    evidence: { kind: 'moving', reason: 'sentry-mutating-order' },
                    observations: [presentObservation('pull-request', '17')],
                } as unknown as TriageScanResultV1],
            })],
            pageLimit: 16,
            observationBudget: 64,
            nowMs: () => 1_000,
        });

        expect(pass.observations).toHaveLength(1);
        expect(pass.lanes[0]?.exhausted).toBe(false);
    });

    /**
     * Truthful exhaustion and a resumable stop are two different questions, and
     * settling the first is what exposed the second.
     *
     * `complete` means the source stopped paging: there is no next page, whatever
     * the evidence says about how much of the set the walk reached. The stop list
     * keys off the page the lane would ask for NEXT, and the only continuation
     * this lane ever held is the one that produced the settling page — so a lane
     * that is now honestly unexhausted would offer it back, and
     * `actions/listEntries.ts` hands it to the mounted store as the window's
     * continuation. Load-more would then re-request the page it just read, get
     * `complete` again, and offer the same continuation forever.
     */
    it('offers no continuation for a walk the source stopped paging, however its evidence settled', async () => {
        const pass = await runTriageScanPass({
            lanes: [lane({
                sourceInstanceId: INSTANCE_ID,
                declaredKindIds: ['pull-request'],
                pages: [
                    {
                        kind: 'page',
                        evidence: WALK_FINISHED,
                        observations: [presentObservation('pull-request', '17')],
                        continuation: { v: 1, token: 'next' },
                    } as unknown as TriageScanResultV1,
                    {
                        kind: 'complete',
                        evidence: { kind: 'partial', reason: 'result-ceiling' },
                        observations: [presentObservation('pull-request', '18')],
                    } as unknown as TriageScanResultV1,
                ],
            })],
            pageLimit: 16,
            observationBudget: 64,
            nowMs: () => 1_000,
        });

        expect(pass.observations.map((observation) => observation.entryRef.entryId))
            .toEqual(['17', '18']);
        expect(pass.lanes[0]?.exhausted).toBe(false);
        expect(pass.stopped).toEqual([]);
    });

    it('ends a walk that hands back the position it was given', async () => {
        // The provable infinite loop, and the only one that IS provable from a
        // page alone: nothing qualified, no provider row charged, and the very
        // continuation the pass submitted offered back. Asking again cannot
        // return anything else, so it is refused on the first such page rather
        // than after the pass has spent its whole page ceiling on it.
        const pass = await runTriageScanPass({
            lanes: [positionalLane({
                sourceInstanceId: INSTANCE_ID,
                declaredKindIds: ['pull-request'],
                pageFor: (token) => (token === null
                    ? {
                        kind: 'page',
                        evidence: { kind: 'moving', reason: 'live-order' },
                        observations: [presentObservation('pull-request', '17')],
                        continuation: { v: 1, token: 'stuck' },
                    } as unknown as TriageScanResultV1
                    : {
                        kind: 'page',
                        evidence: { kind: 'partial', reason: 'undecodable-items', omittedItemCount: 0 },
                        observations: [],
                        continuation: { v: 1, token: 'stuck' },
                    } as unknown as TriageScanResultV1),
            })],
            pageLimit: 16,
            observationBudget: 64,
            nowMs: () => 1_000,
        });

        expect(pass.observations.map((observation) => observation.entryRef.entryId)).toEqual(['17']);
        expect(pass.lanes[0]?.health).toMatchObject({
            kind: 'failed',
            failure: { class: 'transient', code: 'triage/stalledWalk' },
        });
        expect(pass.lanes[0]?.exhausted).toBe(false);
        // A stalled lane is never offered back as a page to continue from.
        expect(pass.stopped).toEqual([]);
    });

    it('settles a same-token zero-observation page even when omissions consumed its row limit', async () => {
        const pass = await runTriageScanPass({
            lanes: [positionalLane({
                sourceInstanceId: INSTANCE_ID,
                declaredKindIds: ['pull-request'],
                pageFor: (token) => (token === null
                    ? {
                        kind: 'page',
                        evidence: { kind: 'partial', reason: 'undecodable-items', omittedItemCount: 1 },
                        observations: [],
                        continuation: { v: 1, token: 'stuck-with-omission' },
                    } as unknown as TriageScanResultV1
                    : {
                        kind: 'page',
                        evidence: { kind: 'partial', reason: 'undecodable-items', omittedItemCount: 1 },
                        observations: [],
                        continuation: { v: 1, token: 'stuck-with-omission' },
                    } as unknown as TriageScanResultV1),
            })],
            pageLimit: 16,
            observationBudget: 64,
            nowMs: () => 1_000,
        });

        expect(pass.lanes[0]?.health).toMatchObject({
            kind: 'failed',
            failure: { class: 'transient', code: 'triage/stalledWalk' },
        });
        expect(pass.lanes[0]?.exhausted).toBe(false);
        expect(pass.stopped).toEqual([]);
    });

    it('reaches a row waiting behind pages that traverse containers and deliver nothing', async () => {
        /*
         * The starvation this guard caused, stated in the terms of the source
         * that hit it: a forge whose review involvement is repository-scoped
         * walks CONTAINERS, and a repository with no open pull request answers
         * zero rows. Such a page qualifies nothing and charges nothing, yet it
         * moved: its continuation names a position strictly past the one it was
         * given, and the very next page can deliver.
         *
         * Refusing it as non-progress killed the lane on its first empty
         * container. The lane was then excluded from `stopped`, so no
         * continuation came back, so the next refresh restarted at the same
         * empty containers — for ever. The row behind them was not merely
         * delayed; it was unreachable.
         */
        const emptyContainers = 6;
        const pass = await runTriageScanPass({
            lanes: [positionalLane({
                sourceInstanceId: INSTANCE_ID,
                declaredKindIds: ['pull-request'],
                pageFor: (token) => {
                    const walked = token === null ? 0 : Number(token);
                    return walked < emptyContainers
                        ? {
                            kind: 'page',
                            evidence: { kind: 'partial', reason: 'container-budget' },
                            observations: [],
                            continuation: { v: 1, token: String(walked + 1) },
                        } as unknown as TriageScanResultV1
                        : {
                            kind: 'complete',
                            evidence: { kind: 'walkFinished' },
                            observations: [presentObservation('pull-request', 'waiting-review')],
                        } as unknown as TriageScanResultV1;
                },
            })],
            pageLimit: 16,
            observationBudget: 64,
            nowMs: () => 1_000,
        });

        expect(pass.observations.map((observation) => observation.entryRef.entryId))
            .toEqual(['waiting-review']);
        expect(pass.lanes[0]?.health).toEqual({ kind: 'walkFinished' });
        expect(pass.lanes[0]?.exhausted).toBe(true);
    });
});
