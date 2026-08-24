import { describe, expect, it } from 'vitest';

import { CORPUS_LANE } from '../../corpus/fold/lane.js';
import {
    testkitLocator,
    testkitSnapshot,
    testkitViewer,
} from '../../corpus/testkit/observations.test-support.js';
import { triageEntryRowKey, type TriageListRowV1 } from '../../projection/listWindow.js';
import { projectTriageBulkSelectedEntriesV1 } from './bulkSelectionEntries.js';

const SOURCE = { pluginId: 'happier.forge', localId: 'items' } as const;
const SHOWING = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

function entryRef(entryId: string) {
    return { source: SOURCE, kindId: 'pull-request', collisionScope: 'origin', entryId } as const;
}

function present(input: Readonly<{
    sourceInstanceId: string;
    title: string;
    scopeLabel: string;
}>) {
    return {
        sourceInstanceId: input.sourceInstanceId,
        observedAtMs: 1_000,
        outcome: {
            kind: 'present' as const,
            locator: testkitLocator(),
            snapshot: testkitSnapshot({ title: input.title, scopeLabel: input.scopeLabel }),
            viewer: testkitViewer(),
        },
    };
}

function row(input: Readonly<{
    entryId: string;
    selected?: TriageListRowV1['selected'];
    observations?: TriageListRowV1['observations'];
}>): TriageListRowV1 {
    const observations = input.observations ?? [present({
        sourceInstanceId: SHOWING,
        title: `Entry ${input.entryId}`,
        scopeLabel: 'forge/repo',
    })];
    return {
        entryRef: entryRef(input.entryId),
        content: observations[0] ?? null,
        lane: CORPUS_LANE.open,
        sortAtMs: 1_000,
        presence: { kind: 'present', observedAtMs: 1_000 },
        attention: null,
        selected: input.selected
            ?? { kind: 'selected', sourceInstanceId: SHOWING, reason: 'onlyPresent' },
        observations,
    };
}

describe('projecting a bulk selection onto the loaded window', () => {
    it('answers in the reader’s own selection order, not the window’s', () => {
        const rows = [row({ entryId: '1' }), row({ entryId: '2' }), row({ entryId: '3' })];
        const keys = [
            triageEntryRowKey(entryRef('3')),
            triageEntryRowKey(entryRef('1')),
        ];

        const projected = projectTriageBulkSelectedEntriesV1({ rows, keys });

        expect(projected.entries.map((entry) => entry.entryRef.entryId)).toEqual(['3', '1']);
        expect(projected.unavailableKeys).toEqual([]);
    });

    it('carries the connection the row is SHOWING, never the first present one', () => {
        // The Corpus already decided which connection this row is read through.
        // A payload built from "the first present observation" attaches the
        // entry under an account the reader is not looking at, and nothing
        // downstream can notice.
        const rows = [row({
            entryId: '7',
            selected: { kind: 'selected', sourceInstanceId: OTHER, reason: 'attention' },
            observations: [
                present({ sourceInstanceId: SHOWING, title: 'Wrong one', scopeLabel: 'forge/other' }),
                present({ sourceInstanceId: OTHER, title: 'Shown one', scopeLabel: 'forge/repo' }),
            ],
        })];

        const projected = projectTriageBulkSelectedEntriesV1({
            rows,
            keys: [triageEntryRowKey(entryRef('7'))],
        });

        expect(projected.entries[0]?.sourceInstance.sourceInstanceId).toBe(OTHER);
        expect(projected.entries[0]?.presentation.label).toBe('Shown one');
    });

    it('reports the rows it cannot answer for instead of refusing the whole selection', () => {
        // Five valid choices must not be thrown away because a sixth row lost
        // its connection. The press acts on what it can and says what it left.
        const rows = [
            row({ entryId: '1' }),
            row({
                entryId: '2',
                selected: { kind: 'none', reason: 'allInstancesRetired' },
                observations: [],
            }),
        ];
        const keys = [
            triageEntryRowKey(entryRef('1')),
            triageEntryRowKey(entryRef('2')),
            triageEntryRowKey(entryRef('99')),
        ];

        const projected = projectTriageBulkSelectedEntriesV1({ rows, keys });

        expect(projected.entries.map((entry) => entry.entryRef.entryId)).toEqual(['1']);
        expect(projected.unavailableKeys).toEqual([
            triageEntryRowKey(entryRef('2')),
            triageEntryRowKey(entryRef('99')),
        ]);
    });
});
