import { TriageConfiguredSourceInstanceV1Schema, type TriageScanResultV1 } from '@happier-dev/triage-protocol/v1';
import { describe, expect, it } from 'vitest';

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

    it('ends a walk that consumes nothing and asks to be called again', async () => {
        // A page that qualifies no observation AND charges no provider row has
        // made no progress of any kind, yet offers a continuation. Before this
        // was refused the pass simply asked again — forever, and entirely inside
        // the microtask queue, so it starved the event loop rather than merely
        // hanging this one Action. The per-page deadline cannot catch it: every
        // page answers instantly.
        const pass = await runTriageScanPass({
            lanes: [lane({
                sourceInstanceId: INSTANCE_ID,
                declaredKindIds: ['pull-request'],
                pages: Array.from({ length: 200 }, (_unused, index) => ({
                    kind: 'page',
                    evidence: { kind: 'partial', reason: 'undecodable-items', omittedItemCount: 0 },
                    observations: [],
                    continuation: { v: 1, token: `next-${String(index)}` },
                } as unknown as TriageScanResultV1)),
            })],
            pageLimit: 16,
            observationBudget: 64,
            nowMs: () => 1_000,
        });

        expect(pass.lanes[0]?.health.kind).toBe('failed');
        expect(pass.lanes[0]?.exhausted).toBe(false);
    });

    it('ends a walk that keeps consuming rows without ever converging', async () => {
        // The harder case, and the one that was reproduced: every page answers
        // INSIDE the deadline, charges provider rows, and qualifies nothing. The
        // lane makes "progress" by the only measure the loop had, so it never
        // exits. A source cannot need to consume more rows than the budget it is
        // filling plus one final page; past that it is not converging.
        //
        // The fixture throws once the pass asks past the pages it offered, so a
        // regression fails this test in bounded time instead of hanging the suite.
        const pass = await runTriageScanPass({
            lanes: [lane({
                sourceInstanceId: INSTANCE_ID,
                declaredKindIds: ['pull-request'],
                pages: Array.from({ length: 200 }, (_unused, index) => ({
                    kind: 'page',
                    evidence: { kind: 'partial', reason: 'undecodable-items', omittedItemCount: 4 },
                    observations: [],
                    continuation: { v: 1, token: `next-${String(index)}` },
                } as unknown as TriageScanResultV1)),
            })],
            pageLimit: 16,
            observationBudget: 64,
            nowMs: () => 1_000,
        });

        expect(pass.lanes[0]?.health.kind).toBe('failed');
        expect(pass.lanes[0]?.exhausted).toBe(false);
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
     * The budget is a rotation stop, and a caller may not read it as a ceiling
     * on how many observations come back.
     *
     * It is checked before a lane is asked for a page and never while a page is
     * adopted, because a page is adopted whole or not at all. A source that
     * answers short — the ordinary shape when a lane spends its native page on
     * a scope that holds fewer rows — is therefore asked again while the pass
     * is one observation under budget, and returns a whole page more. The
     * ceiling is `observationBudget - 1 + pageLimit`.
     *
     * The mounted store's neutral read (`listWindowStore.ts#scanInputFor`)
     * depends on exactly this: it is why the aggregate fold really does cut the
     * pass's rows, and why the `order` that read names decides which of them
     * the mount retains.
     */
    it('lets a lane that pages short overrun the budget by up to one page', async () => {
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

        // Two pages of three: the second was asked while the pass held three
        // observations against a budget of four. A budget that capped the pass
        // would have returned four.
        expect(pass.observations).toHaveLength(6);
        expect(pass.lanes[0]?.exhausted).toBe(false);
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
     * `CONTRACT.md` §5.2 and `PLAN.md` `REQ-13`. A source that neither answers
     * nor fails is the one outcome the classification never covered: without an
     * owner-local deadline the pass simply never settles, so the list Action
     * behind it never returns and every other connection's rows are held
     * hostage by one unanswered page.
     */
    it('settles an unanswered page as a classified transient failure and keeps the rows it already had', async () => {
        const signals: AbortSignal[] = [];
        let asked = 0;
        const pass = await runTriageScanPass({
            lanes: [
                answeringLane({
                    sourceInstanceId: INSTANCE_ID,
                    declaredKindIds: ['pull-request'],
                    scan: async (_scanInput, options) => {
                        if (options?.signal) signals.push(options.signal);
                        asked += 1;
                        if (asked === 1) {
                            return {
                                kind: 'page',
                                evidence: { kind: 'partial', reason: 'pageLimit' },
                                observations: [presentObservation('pull-request', '17')],
                                continuation: { v: 1, token: 'next' },
                            } as unknown as TriageScanResultV1;
                        }
                        // The provider never answers this one.
                        return await new Promise<TriageScanResultV1>(() => {});
                    },
                }),
                lane({
                    sourceInstanceId: OTHER_INSTANCE_ID,
                    declaredKindIds: ['pull-request'],
                    pages: [completedPage('21')],
                }),
            ],
            pageLimit: 4,
            observationBudget: 64,
            nowMs: () => 1_000,
            pageDeadlineMs: 5,
        });

        expect(pass.lanes[0]?.health).toEqual({
            kind: 'failed',
            failure: {
                // `transient` is what the shared pacing policy treats as a
                // provider that is busy rather than a user-actionable refusal,
                // so a later view or manual Refresh retries after a bounded
                // backoff instead of being parked.
                class: 'transient',
                code: 'triage/scanPageDeadline',
                detail: expect.any(String),
            },
        });
        // An unanswered lane never claims a settled end of its walk.
        expect(pass.lanes[0]?.exhausted).toBe(false);
        // A deadline is not a contract violation: the page this lane already
        // gave stays, and so does every other lane's.
        expect(pass.observations.map((observation) => observation.entryRef.entryId))
            .toEqual(['17', '21']);
        // We stopped waiting, so the provider work stops too — otherwise the
        // pass that replaces this one starts a second walk beside a first that
        // is still running.
        expect(signals.at(-1)?.aborted).toBe(true);
    });

    it('applies nothing a timed-out page returns while the pass is still running', async () => {
        let settleLate: ((result: TriageScanResultV1) => void) | undefined;
        const pass = await runTriageScanPass({
            lanes: [
                answeringLane({
                    sourceInstanceId: INSTANCE_ID,
                    declaredKindIds: ['pull-request'],
                    // Never answers before the deadline.
                    scan: async () => await new Promise<TriageScanResultV1>((resolve) => {
                        settleLate = resolve;
                    }),
                }),
                answeringLane({
                    sourceInstanceId: OTHER_INSTANCE_ID,
                    declaredKindIds: ['pull-request'],
                    scan: async () => {
                        // The abandoned lane answers now, while the pass is
                        // still walking this one.
                        settleLate?.(completedPage('late'));
                        await new Promise<void>((resolve) => {
                            setTimeout(resolve, 0);
                        });
                        return completedPage('21');
                    },
                }),
            ],
            pageLimit: 4,
            observationBudget: 64,
            nowMs: () => 1_000,
            pageDeadlineMs: 5,
        });

        expect(pass.observations.map((observation) => observation.entryRef.entryId)).toEqual(['21']);
        expect(pass.lanes[0]?.health).toMatchObject({ kind: 'failed', failure: { class: 'transient' } });
        expect(pass.lanes[0]?.exhausted).toBe(false);
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
        expect(pass.lanes[0]?.exhausted).toBe(true);
    });
});
