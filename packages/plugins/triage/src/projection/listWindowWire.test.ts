import type { TriageSourceViewerFactsV1 } from '@happier-dev/triage-protocol/v1';
import { describe, expect, it } from 'vitest';

import { MAX_TRIAGE_LIST_ROW_OTHER_OBSERVATIONS_V1 } from '../actions/listEntriesProtocol.js';
import type { TriageListEntriesResultV1 } from '../actions/listEntriesProtocol.js';
import type { CorpusQualifiedObservationV1 } from '../corpus/fold/qualify.js';
import { qualifySourceObservation } from '../corpus/fold/qualify.js';
import {
    testkitLocator,
    TESTKIT_SOURCE_INSTANCE_ID,
    testkitEntryRef,
    testkitPresentOutcome,
    testkitSnapshot,
    testkitViewer,
} from '../corpus/testkit/observations.test-support.js';
import { resolveTriageActionPlacementV1 } from '../sessions/actionLaunch.js';
import { readTriageSelectedObservationV1 } from '../ui/window/selectedObservation.js';
import {
    TRIAGE_LIST_DEFAULT_LENS_V1,
    foldTriageListWindow,
    type TriageListLaneV1,
    type TriageListWindowV1,
} from './listWindow.js';
import { laneObservationsFromWire, toTriageListWireRows } from './listWindowWire.js';

/**
 * `REQ-03` on a wire that has a hard ceiling.
 *
 * One entry observed through two configured connections is one entry with two
 * observations, and the list has to say so. The compact row carries one full
 * rendered answer and names the other connections without duplicating their
 * complete detail payloads into the list.
 *
 * The falsifiers this file exists for are therefore both directions: a wire
 * that quietly drops the second connection, and a wire that quietly carries its
 * content.
 */

const ENTRY_REF = testkitEntryRef();
const SECOND_INSTANCE_ID = '22222222-2222-4222-8222-222222222222';

function instanceId(index: number): string {
    return `${String(index).padStart(8, '0')}-1111-4111-8111-111111111111`;
}

function observation(input: Readonly<{
    sourceInstanceId: string;
    observedAtMs?: number;
    title?: string;
    involvement?: TriageSourceViewerFactsV1['involvement'];
}>): CorpusQualifiedObservationV1 {
    return {
        entryRef: ENTRY_REF,
        sourceInstanceId: input.sourceInstanceId,
        observedAtMs: input.observedAtMs ?? 1_000,
        outcome: testkitPresentOutcome({
            snapshot: testkitSnapshot({ title: input.title ?? 'Replace the duplicated normalizer' }),
            viewer: testkitViewer({ involvement: input.involvement ?? [] }),
        }),
    };
}

function lane(sourceInstanceId: string): TriageListLaneV1 {
    return {
        sourceInstanceId,
        source: ENTRY_REF.source,
        health: { kind: 'walkFinished' },
        exhausted: true,
    };
}

function fold(observations: readonly CorpusQualifiedObservationV1[]): TriageListWindowV1 {
    const sourceInstanceIds = [...new Set(observations.map((entry) => entry.sourceInstanceId))];
    return foldTriageListWindow({
        observations,
        lanes: sourceInstanceIds.map(lane),
        activeSourceInstanceIds: sourceInstanceIds,
        lens: TRIAGE_LIST_DEFAULT_LENS_V1,
        assembledAtMs: 2_000,
    });
}

function resultFor(window: TriageListWindowV1): TriageListEntriesResultV1 {
    return {
        v: 1,
        configuredSources: [],
        window: {
            v: 1,
            rows: toTriageListWireRows(window),
            lanes: window.lanes,
            coverage: window.coverage,
            assembledAtMs: window.assembledAtMs,
        },
    };
}

describe('the list window on the wire', () => {
    it('carries a source repository identity through qualification and the wire to placement', () => {
        const repository = {
            kind: 'github',
            deployment: 'https://github.com',
            repository: 'acme/widgets',
        } as const;
        const qualified = qualifySourceObservation({
            source: ENTRY_REF.source,
            declaredKindIds: [ENTRY_REF.kindId],
            sourceInstanceId: TESTKIT_SOURCE_INSTANCE_ID,
            observedAtMs: 1_000,
            observation: {
                kind: 'present',
                localRef: {
                    kindId: ENTRY_REF.kindId,
                    collisionScope: ENTRY_REF.collisionScope,
                    entryId: ENTRY_REF.entryId,
                },
                locator: testkitLocator(),
                snapshot: testkitSnapshot(),
                viewer: testkitViewer(),
                repository,
            },
        });
        expect(qualified.status).toBe('qualified');
        if (qualified.status !== 'qualified') return;
        expect(qualified.observation.outcome).toMatchObject({ kind: 'present', repository });

        const onWire = resultFor(fold([qualified.observation]));
        expect(onWire.window.rows[0]?.observation.outcome)
            .toMatchObject({ kind: 'present', repository });
        const rehydrated = laneObservationsFromWire(onWire, TESTKIT_SOURCE_INSTANCE_ID);
        expect(rehydrated[0]?.outcome).toMatchObject({ kind: 'present', repository });
        const row = fold(rehydrated).rows[0];
        expect(row?.selected).toMatchObject({ kind: 'selected' });
        const selected = row === undefined ? null : readTriageSelectedObservationV1(row);
        expect(selected?.repository).toEqual(repository);

        const placement = resolveTriageActionPlacementV1({
            workspaceMode: 'repository',
            ...(selected?.repository === undefined
                ? {}
                : { forge: selected.repository }),
            projects: [{
                projectKey: { id: 'workspace-1' },
                serverId: 'server-1',
                machineId: 'machine-1',
                rootPath: '/work/acme/widgets',
                forge: repository,
                worktrees: [],
                reachable: true,
            }],
            registryComplete: true,
        });
        expect(placement).toMatchObject({
            kind: 'launch',
            candidate: { projectKey: { id: 'workspace-1' } },
        });
    });

    it('keeps one entry observed through two connections one row that names both', () => {
        const rows = toTriageListWireRows(fold([
            observation({ sourceInstanceId: TESTKIT_SOURCE_INSTANCE_ID }),
            observation({ sourceInstanceId: SECOND_INSTANCE_ID }),
        ]));

        expect(rows).toHaveLength(1);
        const row = rows[0];
        expect(row?.observedByCount).toBe(2);
        expect(row?.observation.sourceInstanceId).toBe(TESTKIT_SOURCE_INSTANCE_ID);
        expect(row?.otherObservations).toEqual([
            { sourceInstanceId: SECOND_INSTANCE_ID, observedAtMs: 1_000, kind: 'present' },
        ]);
    });

    it('carries the entry content exactly once, whatever the connection count', () => {
        const rows = toTriageListWireRows(fold([
            observation({ sourceInstanceId: TESTKIT_SOURCE_INSTANCE_ID }),
            observation({ sourceInstanceId: SECOND_INSTANCE_ID, title: 'A second account, same pull request' }),
        ]));

        const encoded = JSON.stringify(rows);
        expect(encoded).toContain('Replace the duplicated normalizer');
        expect(encoded).not.toContain('A second account, same pull request');
    });

    it('renders the row from the connection the fold selected', () => {
        const rows = toTriageListWireRows(fold([
            observation({ sourceInstanceId: SECOND_INSTANCE_ID, title: 'The selected account speaks' }),
            observation({ sourceInstanceId: TESTKIT_SOURCE_INSTANCE_ID, involvement: ['reviewRequested'] }),
        ]));

        const row = rows[0];
        expect(row?.selected).toMatchObject({ kind: 'selected', sourceInstanceId: TESTKIT_SOURCE_INSTANCE_ID });
        expect(row?.observation.sourceInstanceId).toBe(TESTKIT_SOURCE_INSTANCE_ID);
    });

    /**
     * The bound is a byte-gate decision, so what matters is that exceeding it
     * is visible. A row that simply listed four of nine connections would be
     * the same silent truncation the configured-set maximum exists to prevent.
     */
    it('reports the true connection count when it carries more than it can list', () => {
        const connections = MAX_TRIAGE_LIST_ROW_OTHER_OBSERVATIONS_V1 + 4;
        const rows = toTriageListWireRows(fold(Array.from(
            { length: connections },
            (_unused, index) => observation({
                sourceInstanceId: instanceId(index),
                // The last connection is the only one with a reason, so the row's
                // attention names a connection the bound would otherwise drop.
                involvement: index === connections - 1 ? ['reviewRequested'] : [],
            }),
        )));

        const row = rows[0];
        expect(row?.observedByCount).toBe(connections);
        expect(row?.otherObservations).toHaveLength(MAX_TRIAGE_LIST_ROW_OTHER_OBSERVATIONS_V1);
        // The row never names a connection in `attention` that its own list omits.
        const attentionInstanceId = row?.attention?.fromSourceInstanceId;
        expect(attentionInstanceId).toBe(instanceId(connections - 1));
        expect([
            row?.observation.sourceInstanceId,
            ...(row?.otherObservations ?? []).map((entry) => entry.sourceInstanceId),
        ]).toContain(attentionInstanceId);
    });

    it('counts one connection that answered twice as one connection', () => {
        const rows = toTriageListWireRows(fold([
            observation({ sourceInstanceId: TESTKIT_SOURCE_INSTANCE_ID, observedAtMs: 1_000 }),
            observation({ sourceInstanceId: TESTKIT_SOURCE_INSTANCE_ID, observedAtMs: 1_500 }),
        ]));

        expect(rows[0]?.observedByCount).toBe(1);
        expect(rows[0]?.otherObservations).toEqual([]);
    });

    /**
     * A source may report one entry several times in one walk, and a first-party
     * one is designed to: GitHub asks five involvement queries and emits every
     * native encounter separately, each carrying only that lane's fact, because
     * "the aggregate unions the involvement facts idempotently".
     *
     * The wire is where that promise was silently broken. It carries one
     * observation per connection, so whichever encounter happened to be newest
     * became the row's whole viewer record — and the mounted store, which
     * rebuilds its window from exactly what it read back, then derived
     * `suggested` for a pull request the user's review is blocking. The
     * falsifier this test exists for is any repair that re-infers the lost facts
     * from the rendered attention level instead of unioning them before the
     * wire: that would mint involvement no source ever reported.
     */
    it('unions one connection\'s involvement answers before the wire, so a rebuild cannot demote them', () => {
        const window = fold([
            observation({
                sourceInstanceId: TESTKIT_SOURCE_INSTANCE_ID,
                observedAtMs: 1_000,
                involvement: ['reviewRequested'],
            }),
            observation({
                sourceInstanceId: TESTKIT_SOURCE_INSTANCE_ID,
                observedAtMs: 1_500,
                involvement: ['participating'],
            }),
        ]);

        expect(window.rows[0]?.attention?.level).toBe('required');
        expect(toTriageListWireRows(window)[0]?.observedByCount).toBe(1);

        const rehydrated = laneObservationsFromWire(resultFor(window), TESTKIT_SOURCE_INSTANCE_ID);
        expect(rehydrated).toHaveLength(1);
        const outcome = rehydrated[0]?.outcome;
        expect(outcome?.kind === 'present' && [...outcome.viewer.involvement])
            // The protocol's declared order, not the order the lanes answered in.
            .toEqual(['reviewRequested', 'participating']);

        // The mounted store rebuilds from exactly this, so the level has to survive.
        expect(fold(rehydrated).rows[0]?.attention?.level).toBe('required');
    });

    it('rehydrates the driving connection\'s own answer, ref and all', () => {
        const window = fold([observation({ sourceInstanceId: TESTKIT_SOURCE_INSTANCE_ID })]);

        expect(laneObservationsFromWire(resultFor(window), TESTKIT_SOURCE_INSTANCE_ID)).toEqual([{
            entryRef: ENTRY_REF,
            sourceInstanceId: TESTKIT_SOURCE_INSTANCE_ID,
            observedAtMs: 1_000,
            outcome: testkitPresentOutcome({
                snapshot: testkitSnapshot({ title: 'Replace the duplicated normalizer' }),
                viewer: testkitViewer({ involvement: [] }),
            }),
        }]);
        expect(laneObservationsFromWire(resultFor(window), SECOND_INSTANCE_ID)).toEqual([]);
    });
});
