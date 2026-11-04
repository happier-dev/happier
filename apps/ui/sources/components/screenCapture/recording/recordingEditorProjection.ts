import type { ComposerEditorReference } from '@/components/ui/forms/composerEditor/composerEditorTypes';
import { formatPlaybackTime } from '@/components/workspaces/files/file/filePageMediaFacts';

import type { RecordingDocument, RecordingOperation } from './recordingDocument';

const TIME_REF_PREFIX = 'time:';

export type RecordingNoteDraft = Readonly<{ text: string; references: readonly ComposerEditorReference[] }>;
export type RecordingNoteMoment = Readonly<{ id: string; sourceTimeMs: number; text: string }>;
export type ParsedRecordingNote = Readonly<{ lead: string; moments: readonly RecordingNoteMoment[] }>;

const timeChip = (sourceTimeMs: number, start: number): ComposerEditorReference => {
    const token = formatPlaybackTime(sourceTimeMs / 1000);
    return { ref: `${TIME_REF_PREFIX}${sourceTimeMs}`, token, kind: 'recordingTime', label: token, start, end: start + token.length };
};
const chipTime = (chip: ComposerEditorReference) => Number(chip.ref.slice(TIME_REF_PREFIX.length));
const inOrder = (references: readonly ComposerEditorReference[]) => references.slice().sort((left, right) => left.start - right.start);

/** Typing on a paused frame: the chip lands at the caret, once per moment. */
export function insertRecordingTimeChip(draft: RecordingNoteDraft, at: number, sourceTimeMs: number): RecordingNoteDraft {
    const chip = timeChip(sourceTimeMs, at);
    if (draft.references.some(({ ref }) => ref === chip.ref)) return draft;
    const inserted = `${chip.token} `;
    return {
        text: `${draft.text.slice(0, at)}${inserted}${draft.text.slice(at)}`,
        references: inOrder([...draft.references.map((reference) => reference.start >= at
            ? { ...reference, start: reference.start + inserted.length, end: reference.end + inserted.length }
            : reference), chip]),
    };
}

/** The words before any chip travel as the message; the words after a chip are that moment's note. */
export function parseRecordingNoteDraft(draft: RecordingNoteDraft): ParsedRecordingNote {
    const chips = inOrder(draft.references);
    return {
        lead: draft.text.slice(0, chips[0]?.start ?? draft.text.length).trim(),
        moments: chips.map((chip, index) => ({
            id: chip.ref,
            sourceTimeMs: chipTime(chip),
            text: draft.text.slice(chip.end, chips[index + 1]?.start ?? draft.text.length).trim(),
        })),
    };
}

/** The note as it was left: every moment this note can speak for, in time order. */
export function composeRecordingNoteDraft(document: RecordingDocument): RecordingNoteDraft {
    const moments = [
        ...document.notes.filter(({ id }) => id.startsWith(TIME_REF_PREFIX)),
        ...document.pins.map((sourceTimeMs) => ({ sourceTimeMs, text: '' })),
    ].sort((left, right) => left.sourceTimeMs - right.sourceTimeMs);
    let text = '';
    const references: ComposerEditorReference[] = [];
    for (const moment of moments) {
        const chip = timeChip(moment.sourceTimeMs, text.length);
        references.push(chip);
        text += moment.text ? `${chip.token} ${moment.text} ` : `${chip.token} `;
    }
    return { text, references };
}

/** The document edits between two states of the note; what an Agent added stays untouched. */
export function recordingNoteOperations(next: ParsedRecordingNote, previous: ParsedRecordingNote): readonly RecordingOperation[] {
    const operations: RecordingOperation[] = [];
    const kept = new Map(next.moments.map((moment) => [moment.id, moment]));
    for (const moment of previous.moments) {
        const now = kept.get(moment.id);
        if (moment.text && !now?.text) operations.push({ kind: 'note.remove', id: moment.id });
        if (!moment.text && (!now || now.text)) operations.push({ kind: 'pin.remove', sourceTimeMs: moment.sourceTimeMs });
    }
    for (const moment of next.moments) {
        operations.push(moment.text
            ? { kind: 'note.set', id: moment.id, sourceTimeMs: moment.sourceTimeMs, text: moment.text }
            : { kind: 'pin.add', sourceTimeMs: moment.sourceTimeMs });
    }
    return operations;
}

export type RecordingPinSize = Readonly<{ id: string; sourceTimeMs: number; width: number }>;

/** Each pin stands on its time, and neighbours give way along the strip rather than cover each other. */
export function layoutRecordingPins(pins: readonly RecordingPinSize[], track: Readonly<{ durationMs: number; trackWidth: number; gap: number }>) {
    const { durationMs, trackWidth, gap } = track;
    const ordered = pins.slice().sort((left, right) => left.sourceTimeMs - right.sourceTimeMs);
    const placed = ordered.map((pin) => {
        const centre = durationMs > 0 ? (pin.sourceTimeMs / durationMs) * trackWidth : 0;
        return { id: pin.id, width: pin.width, x: Math.max(0, Math.min(trackWidth - pin.width, centre - pin.width / 2)) };
    });
    for (let index = 1; index < placed.length; index += 1) {
        placed[index]!.x = Math.max(placed[index]!.x, placed[index - 1]!.x + placed[index - 1]!.width + gap);
    }
    let limit = trackWidth;
    for (let index = placed.length - 1; index >= 0; index -= 1) {
        const pin = placed[index]!;
        pin.x = Math.min(pin.x, limit - pin.width);
        limit = pin.x - gap;
    }
    return placed.map(({ id, x }) => ({ id, x }));
}

type Rect = Readonly<{ x: number; y: number; width: number; height: number }>;

/** MIS §7: under the area; inside its bottom edge when the area reaches the bottom of the screen. */
export function resolveRecordingControlPlace(input: Readonly<{
    area: Rect | null;
    pill: Readonly<{ width: number; height: number }>;
    workArea: Rect;
    gap: number;
}>): Readonly<{ x: number; y: number }> {
    const { area, pill, workArea, gap } = input;
    const bottom = workArea.y + workArea.height - gap - pill.height;
    const centreX = area ? area.x + area.width / 2 : workArea.x + workArea.width / 2;
    const x = Math.max(workArea.x + gap, Math.min(workArea.x + workArea.width - gap - pill.width, centreX - pill.width / 2));
    if (!area) return { x, y: bottom };
    const under = area.y + area.height + gap;
    return { x, y: under <= bottom ? under : Math.min(bottom, area.y + area.height - gap - pill.height) };
}
