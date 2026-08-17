import { describe, expect, it } from 'vitest';

import { CORPUS_LANE } from '../corpus/fold/lane.js';
import {
    testkitLocator,
    testkitSnapshot,
    testkitViewer,
} from '../corpus/testkit/observations.test-support.js';
import type { TriageListRowV1, TriageListWindowV1 } from '../projection/listWindow.js';
import type { TriageListWindowSnapshotV1 } from '../projection/listWindowStore.js';
import { projectTriagePickerCorpusFacts } from './pickerFacts.js';

const SOURCE = { pluginId: 'happier.forge', localId: 'items' } as const;
const INSTANCE = '11111111-1111-4111-8111-111111111111';
const ASSEMBLED_AT_MS = 1_760_000_000_000;

function row(): TriageListRowV1 {
    return {
        entryRef: { source: SOURCE, kindId: 'pull-request', collisionScope: 'origin', entryId: '42' },
        lane: CORPUS_LANE.open,
        sortAtMs: 1_000,
        presence: { kind: 'present', observedAtMs: 1_000 },
        attention: null,
        selected: { kind: 'selected', sourceInstanceId: INSTANCE, reason: 'onlyPresent' },
        observations: [{
            sourceInstanceId: INSTANCE,
            observedAtMs: 1_000,
            outcome: {
                kind: 'present',
                locator: testkitLocator(),
                snapshot: testkitSnapshot({ title: 'Fix the parser', scopeLabel: 'forge/repo' }),
                viewer: testkitViewer(),
            },
        }],
    };
}

function window(overrides: Partial<TriageListWindowV1> = {}): TriageListWindowV1 {
    return {
        v: 1,
        rows: [row()],
        lanes: [],
        coverage: 'complete',
        assembledAtMs: ASSEMBLED_AT_MS,
        ...overrides,
    };
}

function snapshot(overrides: Partial<TriageListWindowSnapshotV1> = {}): TriageListWindowSnapshotV1 {
    return {
        freshness: 'fresh',
        pending: 'idle',
        configuredSources: [{
            sourceInstanceId: INSTANCE,
            source: SOURCE,
            displayLabel: 'forge/repo',
            available: true,
        }],
        ...overrides,
    };
}

describe('projectTriagePickerCorpusFacts', () => {
    it('reports a cold window as never synchronized rather than empty', () => {
        // The picker over a cold projection must show that state and an explicit
        // Refresh; an empty row list would read as "there is nothing to attach".
        const facts = projectTriagePickerCorpusFacts({ snapshot: snapshot(), nowMs: 1 });

        expect(facts.freshness).toEqual({ kind: 'neverSynchronized' });
        expect(facts.rows).toEqual([]);
        expect(facts.configuredSourceInstanceCount).toBe(1);
        // A window that has not exhausted its lanes has concluded no absence.
        expect(facts.coverage).toBe('progressive');
    });

    it('carries the window\'s own rows, titles and instance decision', () => {
        const facts = projectTriagePickerCorpusFacts({
            snapshot: snapshot({ window: window() }),
            nowMs: 1,
        });

        expect(facts.freshness).toEqual({ kind: 'current' });
        expect(facts.coverage).toBe('complete');
        expect(facts.rows).toEqual([{
            entryRef: row().entryRef,
            title: 'Fix the parser',
            scopeLabel: 'forge/repo',
            instance: { kind: 'selected', sourceInstanceId: INSTANCE, reason: 'onlyPresent' },
        }]);
    });

    it('takes staleness as a decided fact instead of judging it locally', () => {
        const facts = projectTriagePickerCorpusFacts({
            snapshot: snapshot({ window: window(), freshness: 'stale' }),
            nowMs: ASSEMBLED_AT_MS + 1,
        });

        expect(facts.freshness).toEqual({ kind: 'stale', lastMaterializedAtMs: ASSEMBLED_AT_MS });
    });

    it('names a failed connection by the label the user gave it', () => {
        const facts = projectTriagePickerCorpusFacts({
            snapshot: snapshot({
                window: window({
                    lanes: [{
                        sourceInstanceId: INSTANCE,
                        source: SOURCE,
                        health: { kind: 'failed', failure: { class: 'transient', code: 'provider-busy' } },
                        exhausted: false,
                    }],
                }),
            }),
            nowMs: 1,
        });

        expect(facts.health).toEqual([{
            sourceInstance: { source: SOURCE, sourceInstanceId: INSTANCE },
            displayName: 'forge/repo',
            failure: { class: 'transient', code: 'provider-busy' },
        }]);
    });
});
