import { describe, expect, it } from 'vitest';

import { createRecordingDocument, projectRecordingDocument, reduceRecordingDocument } from './recordingDocument';
import {
    composeRecordingNoteDraft,
    insertRecordingTimeChip,
    layoutRecordingPins,
    parseRecordingNoteDraft,
    recordingNoteOperations,
    resolveRecordingControlPlace,
} from './recordingEditorProjection';

const document = () => createRecordingDocument({ frameDurationMs: 1000 / 25, sourceCaptureRef: 'capture-1', durationMs: 42_000, includeWindowText: false });

describe('the note with time chips', () => {
    it('splits the note into the words before any chip and the words after each chip', () => {
        const first = insertRecordingTimeChip({ text: 'Look: the total jumps', references: [] }, 6, 11_000);
        expect(first.text).toBe('Look: 0:11 the total jumps');
        const second = insertRecordingTimeChip({ ...first, text: `${first.text}, then Pay slides` }, `${first.text}, then `.length, 18_000);
        expect(parseRecordingNoteDraft(second)).toEqual({
            lead: 'Look:',
            moments: [
                { id: 'time:11000', sourceTimeMs: 11_000, text: 'the total jumps, then' },
                { id: 'time:18000', sourceTimeMs: 18_000, text: 'Pay slides' },
            ],
        });
    });

    it('moves chips that sit after the caret when a chip is inserted before them', () => {
        const later = insertRecordingTimeChip({ text: 'end', references: [] }, 3, 20_000);
        const earlier = insertRecordingTimeChip(later, 0, 5_000);
        expect(earlier.references.map((chip) => earlier.text.slice(chip.start, chip.end))).toEqual(['0:05', '0:20']);
    });

    it('never inserts a second chip for a moment the note already has', () => {
        const once = insertRecordingTimeChip({ text: '', references: [] }, 0, 5_000);
        expect(insertRecordingTimeChip(once, once.text.length, 5_000)).toBe(once);
    });

    it('commits words as timestamped notes, a bare chip as a pin, and only removes what this note wrote', () => {
        const agent = reduceRecordingDocument(document(), { kind: 'note.set', id: 'agent', sourceTimeMs: 1_000, text: 'from the agent' });
        const typed = insertRecordingTimeChip(insertRecordingTimeChip({ text: 'gone', references: [] }, 0, 3_000), 0, 2_000);
        const draft = parseRecordingNoteDraft(typed);
        const committed = recordingNoteOperations(draft, { lead: '', moments: [] }).reduce(reduceRecordingDocument, agent);
        expect(committed.notes.map(({ id, text }) => [id, text])).toEqual([['agent', 'from the agent'], ['time:3000', 'gone']]);
        expect(committed.pins).toEqual([2_000]);
        const cleared = recordingNoteOperations({ lead: '', moments: [] }, draft).reduce(reduceRecordingDocument, committed);
        expect(cleared.notes.map(({ id }) => id)).toEqual(['agent']);
        expect(cleared.pins).toEqual([]);
    });

    it('reopens a committed document as the same note', () => {
        const typed = insertRecordingTimeChip({ text: 'gone', references: [] }, 0, 3_000);
        const committed = recordingNoteOperations(parseRecordingNoteDraft(typed), { lead: '', moments: [] })
            .reduce(reduceRecordingDocument, document());
        const reopened = composeRecordingNoteDraft(committed);
        expect(parseRecordingNoteDraft(reopened)).toEqual(parseRecordingNoteDraft(typed));
    });

    it('counts a typed moment as a selected frame before it is committed', () => {
        const draft = parseRecordingNoteDraft(insertRecordingTimeChip({ text: 'x', references: [] }, 0, 3_000));
        const projected = projectRecordingDocument(recordingNoteOperations(draft, { lead: '', moments: [] }).reduce(reduceRecordingDocument, document()));
        expect(projected.frames.map(({ sourceTimeMs }) => sourceTimeMs)).toEqual([3_000]);
    });
});

describe('pins over the strip', () => {
    const pin = (id: string, sourceTimeMs: number, width: number) => ({ id, sourceTimeMs, width });
    it('centres a pin on its time', () => {
        expect(layoutRecordingPins([pin('a', 21_000, 20)], { durationMs: 42_000, trackWidth: 420, gap: 4 })).toEqual([{ id: 'a', x: 200 }]);
    });
    it('keeps neighbours apart and inside the strip, in time order', () => {
        const placed = layoutRecordingPins([pin('late', 42_000, 40), pin('mark', 10_000, 20), pin('note', 10_000, 40)],
            { durationMs: 42_000, trackWidth: 420, gap: 4 });
        expect(placed).toEqual([{ id: 'mark', x: 90 }, { id: 'note', x: 114 }, { id: 'late', x: 380 }]);
    });
    it('slides the row back when the last pin reaches the end of the strip', () => {
        const placed = layoutRecordingPins([pin('a', 41_000, 40), pin('b', 42_000, 40)], { durationMs: 42_000, trackWidth: 420, gap: 4 });
        expect(placed).toEqual([{ id: 'a', x: 336 }, { id: 'b', x: 380 }]);
    });
});

describe('where the recording control stands', () => {
    const workArea = { x: 0, y: 30, width: 1440, height: 870 };
    const pill = { width: 220, height: 44 };
    it('stands centred under the area', () => {
        expect(resolveRecordingControlPlace({ area: { x: 700, y: 140, width: 500, height: 400 }, pill, workArea, gap: 16 }))
            .toEqual({ x: 840, y: 556 });
    });
    it('moves inside the bottom edge when the area reaches the bottom of the screen', () => {
        expect(resolveRecordingControlPlace({ area: { x: 100, y: 300, width: 600, height: 600 }, pill, workArea, gap: 16 }))
            .toEqual({ x: 290, y: 840 });
    });
    it('stays on screen when the area touches a side', () => {
        expect(resolveRecordingControlPlace({ area: { x: 0, y: 100, width: 100, height: 100 }, pill, workArea, gap: 16 }))
            .toEqual({ x: 16, y: 216 });
    });
    it('stands at the bottom centre without an area', () => {
        expect(resolveRecordingControlPlace({ area: null, pill, workArea, gap: 16 })).toEqual({ x: 610, y: 840 });
    });
});
