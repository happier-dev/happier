import { buildReviewUnits, type ReviewUnit } from '@happier-dev/protocol/scm/comparisonOccurrences';
import { revertHunks, type Hunk, type HunkApplyResult } from '@happier-dev/protocol/diff/hunks';
import type { ScmChangeOccurrence } from '@happier-dev/protocol/scm/comparison';
import type { EditorDecoration } from './codeEditorTypes';
import { diffArrays } from 'diff';

export type EditorChangeMarker = Extract<EditorDecoration, { kind: string }> & Readonly<{ hunk: Hunk; rangeNewLines?: number }>;
export type EditorChangeMarkerSeed = Readonly<{ key: string; text: string; items: readonly EditorChangeMarker[] }>;
export type EditorChangeRevertResult = HunkApplyResult | Readonly<{ ok: false; reason: 'unavailable' }>;

export function buildEditorChangeMarkers(path: string, layer: ScmChangeOccurrence['layer'] | null | undefined, unifiedDiff: string,
    reviewUnits: readonly ReviewUnit[] = buildReviewUnits(path, layer, unifiedDiff)): readonly EditorChangeMarker[] {
    return reviewUnits.map((unit) => {
        const original = unit.hunk;
        // Context is anchoring evidence for disk writes. A tracked editor range already supplies the
        // location, and only the changed lines must match when reverting the person's draft.
        const prefix = original.lines.slice(0, original.firstChange);
        const changed = original.lines.slice(original.firstChange, original.lastChange + 1);
        const oldLines = changed.filter((line) => line.kind !== 'add').length;
        const newLines = changed.filter((line) => line.kind !== 'remove').length;
        const oldOffset = (original.oldLines ? original.oldStart - 1 : original.oldStart) + prefix.filter((line) => line.kind !== 'add').length;
        const newOffset = (original.newLines ? original.newStart - 1 : original.newStart) + prefix.filter((line) => line.kind !== 'remove').length;
        let oldLine = oldOffset;
        let newLine = newOffset;
        const lines = changed.map((line) => {
            const firstOldLine = line.kind !== 'add' && oldLine++ === 0;
            const firstNewLine = line.kind !== 'remove' && newLine++ === 0;
            // File decoding removes only a leading BOM. Review identity remains the raw-byte unit key.
            return (firstOldLine || firstNewLine) && line.text.startsWith('\uFEFF') ? { ...line, text: line.text.slice(1) } : line;
        });
        const hunk: Hunk = { ...original, oldStart: oldOffset + (oldLines ? 1 : 0), newStart: newOffset + (newLines ? 1 : 0), oldLines, newLines,
            lines, firstChange: 0, lastChange: lines.length - 1 };
        const startLine = Math.max(1, hunk.newStart);
        return { id: unit.key, key: unit.key, kind: oldLines === 0 ? 'added' : newLines === 0 ? 'deleted' : 'modified',
            startLine, endLine: startLine + Math.max(0, newLines - 1), removedLines: lines.filter((line) => line.kind === 'remove').map((line) => line.text),
            ...(newLines === 0 ? { anchor: hunk.newStart === 0 ? 'before' as const : 'after' as const } : {}), hunk };
    });
}

export function revertEditorChangeInDraft(draftText: string, marker: EditorChangeMarker): EditorChangeRevertResult {
    if (marker.rangeNewLines !== undefined && marker.rangeNewLines !== marker.hunk.newLines) return { ok: false, reason: 'moved_on' };
    if (marker.hunk.newLines > 0 && marker.endLine - marker.startLine + 1 !== marker.hunk.newLines) return { ok: false, reason: 'moved_on' };
    const newStart = marker.hunk.newLines ? marker.startLine : marker.startLine - (marker.hunk.newStart === 0 ? 1 : 0);
    const result = revertHunks(draftText, [{ ...marker.hunk, newStart }]);
    // Encoding-only changes belong to the file editor's encoding owner, never an engine text command.
    return result.ok && result.text === draftText ? { ok: false, reason: 'unavailable' } : result;
}

/** Reconcile history against the immutable scope; null refuses an incompatible seed instead of guessing ranges. */
export function rederiveEditorChangeMarkers(seedText: string, draftText: string, markers: readonly EditorChangeMarker[]): readonly EditorChangeMarker[] | null {
    const baseline = revertHunks(seedText, markers.map(marker => marker.hunk));
    if (!baseline.ok) return null;
    // Preserve terminators: CRLF and a final unterminated line are part of the guarded hunk contract.
    const lines = (text: string) => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
    const draftLines = lines(draftText);
    const project = (reference: string) => {
        const edits: { from: number; to: number; inserted: number }[] = [];
        let position = 0;
        let edit: (typeof edits)[number] | null = null;
        for (const change of diffArrays(lines(reference), draftLines)) {
            if (!change.added && !change.removed) {
                if (edit) { edits.push(edit); edit = null; }
                position += change.value.length;
            } else {
                edit ??= { from: position, to: position, inserted: 0 };
                if (change.removed) { position += change.value.length; edit.to = position; }
                else edit.inserted += change.value.length;
            }
        }
        if (edit) edits.push(edit);
        const boundary = (line: number, end: boolean, point: boolean) => {
            let delta = 0;
            for (const change of edits) {
                if (line < change.from) break;
                if (line > change.to) { delta += change.inserted - (change.to - change.from); continue; }
                if (change.from === change.to) return line + delta + ((end === point) ? change.inserted : 0);
                if (line === change.to) return change.from + delta + change.inserted;
                return change.from + delta + (line > change.from && end ? change.inserted : 0);
            }
            return line + delta;
        };
        return (from: number, count: number) => {
            const start = boundary(from, false, count === 0);
            return { start, end: Math.max(start, boundary(from + count, true, count === 0)) };
        };
    };
    // The old side decides whether the scope change remains. The saved new side places it without
    // absorbing unrelated draft typing adjacent to a change into that change's tracked range.
    const oldRange = project(baseline.text);
    const newRange = project(seedText);
    return markers.flatMap(marker => {
        const { hunk } = marker;
        const from = hunk.oldLines ? hunk.oldStart - 1 : hunk.oldStart;
        const old = oldRange(from, hunk.oldLines);
        const oldText = hunk.lines.filter(line => line.kind !== 'add').map(line => line.text + (line.noEol ? '' : '\n')).join('');
        if (draftLines.slice(old.start, old.end).join('') === oldText) return [];
        const { start, end } = newRange(hunk.newLines ? hunk.newStart - 1 : hunk.newStart, hunk.newLines);
        const startLine = hunk.newLines === 0 ? Math.max(1, start) : Math.max(1, Math.min(draftLines.length, start + 1));
        return [{ ...marker, startLine, endLine: Math.max(startLine, end), rangeNewLines: end - start,
            ...(hunk.newLines === 0 ? { anchor: start === 0 ? 'before' as const : 'after' as const, hunk: { ...hunk, newStart: start } } : {}) }];
    });
}
