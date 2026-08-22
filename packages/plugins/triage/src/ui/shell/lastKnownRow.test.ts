import { describe, expect, it } from 'vitest';

import { CORPUS_LANE } from '../../corpus/fold/lane.js';
import {
    testkitLocator,
    testkitPresentOutcome,
    testkitSnapshot,
    testkitViewer,
} from '../../corpus/testkit/observations.test-support.js';
import type { TriageListRowV1 } from '../../projection/listWindow.js';
import type { TriageSurfaceSelectionV1 } from '../state/surface.js';
import { retainTriageLastKnownRowV1 } from './lastKnownRow.js';

/**
 * What the detail header is allowed to keep showing.
 *
 * The failure this boundary exists to prevent is not an empty header — it is a
 * confident one about the wrong entry. So the discriminating cases are the two
 * moves that must throw the held row away: the reader opening a different
 * entry, and the reader opening the same entry through a different connection.
 */

const SOURCE = { pluginId: 'happier.forge', localId: 'items' } as const;
const INSTANCE = '11111111-1111-4111-8111-111111111111';
const OTHER_INSTANCE = '22222222-2222-4222-8222-222222222222';

function row(entryId = '42'): TriageListRowV1 {
    const outcome = testkitPresentOutcome({
        locator: testkitLocator(),
        snapshot: testkitSnapshot({ title: `Fix the parser ${entryId}` }),
        viewer: testkitViewer(),
    });
    return {
        entryRef: { source: SOURCE, kindId: 'pull-request', collisionScope: 'origin', entryId },
        content: { sourceInstanceId: INSTANCE, observedAtMs: 1_000, outcome },
        lane: CORPUS_LANE.open,
        sortAtMs: 1_000,
        presence: { kind: 'present' },
        attention: null,
        selected: { kind: 'selected', sourceInstanceId: INSTANCE, reason: 'onlyPresent' },
        observations: [{ sourceInstanceId: INSTANCE, observedAtMs: 1_000, outcome }],
    };
}

function selection(
    overrides: Partial<TriageSurfaceSelectionV1> = {},
): TriageSurfaceSelectionV1 {
    return {
        sectionId: '1-open',
        entryRef: row().entryRef,
        sourceInstanceId: INSTANCE,
        ...overrides,
    };
}

describe('retainTriageLastKnownRowV1', () => {
    it('keeps the last listed row when the window stops holding it', () => {
        const listed = row();
        const held = retainTriageLastKnownRowV1(null, selection(), listed);

        expect(retainTriageLastKnownRowV1(held, selection(), null)).toBe(held);
    });

    it('drops it when the reader selects another entry', () => {
        // The held row would otherwise be rendered under the new selection's
        // heading: a confident header about an entry nobody opened.
        const held = retainTriageLastKnownRowV1(null, selection(), row());

        expect(retainTriageLastKnownRowV1(
            held,
            selection({ entryRef: row('43').entryRef }),
            null,
        )).toBeNull();
    });

    it('drops it when the same entry is opened through another connection', () => {
        // One entry two of the reader's accounts both observe is ordinary, and
        // the connection is what the detail is read through — so the previous
        // account's answer is not this selection's.
        const held = retainTriageLastKnownRowV1(null, selection(), row());

        expect(retainTriageLastKnownRowV1(
            held,
            selection({ sourceInstanceId: OTHER_INSTANCE }),
            null,
        )).toBeNull();
    });

    it('holds nothing once the selection is cleared', () => {
        const held = retainTriageLastKnownRowV1(null, selection(), row());

        expect(retainTriageLastKnownRowV1(held, null, null)).toBeNull();
    });

    it('survives the row being regrouped into another section', () => {
        // The section is where a row is shown, not which entry it is. Resetting
        // on it would throw the header away because a heading moved.
        const held = retainTriageLastKnownRowV1(null, selection(), row());

        expect(retainTriageLastKnownRowV1(
            held,
            selection({ sectionId: '2-done' }),
            null,
        )).toBe(held);
    });

    it('re-reads the current row and keeps its identity while it does not move', () => {
        const listed = row();
        const held = retainTriageLastKnownRowV1(null, selection(), listed);

        expect(held?.row).toBe(listed);
        expect(retainTriageLastKnownRowV1(held, selection(), listed)).toBe(held);
        // A newly published row for the same selection replaces the held one:
        // the freshest answer is the one the header must show.
        const republished = row();
        expect(retainTriageLastKnownRowV1(held, selection(), republished)?.row).toBe(republished);
    });
});
