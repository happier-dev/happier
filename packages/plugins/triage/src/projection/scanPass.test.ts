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
}>): TriageScanLaneV1 {
    let index = 0;
    return {
        sourceInstanceId: input.sourceInstanceId,
        source: SOURCE,
        declaredKindIds: input.declaredKindIds,
        configured: configured(input.sourceInstanceId),
        scan: async () => {
            const page = input.pages[index];
            index += 1;
            if (page === undefined) throw new Error('the pass asked for a page the lane never offered');
            return page;
        },
    };
}

const WALK_FINISHED = { kind: 'walkFinished' } as const;

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
});
