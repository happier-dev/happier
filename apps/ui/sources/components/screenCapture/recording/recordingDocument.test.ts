import { describe, expect, it } from 'vitest';
import { ImageMarksDocumentV1Schema, applyImageMarksOperations } from '@happier-dev/protocol';
import { createImageAnnotator } from '@/components/ui/media/annotation/annotatorStore';
import { createCaptureDisclosureState, reduceCaptureDisclosure } from '../disclosure/captureDisclosureRule';
import { applyRecordingFrameOperations, createRecordingDocument, projectRecordingDocument,
    readRecordingFrameDocument, reduceRecordingDocument, type RecordingDocument } from './recordingDocument';

const empty = ImageMarksDocumentV1Schema.parse({ v: 1, image: { width: 80, height: 60, scale: 1 }, marks: [] });
const marked = applyImageMarksOperations(empty, [{ kind: 'mark.add', mark: { id: 'arrow', kind: 'arrow',
    from: { x: 1, y: 2 }, to: { x: 40, y: 20 }, color: 'red', size: 'm' } }]);

describe('recording source-time document', () => {
    it('keeps at least one media frame when either trim handle reaches the other', () => {
        const document = createRecordingDocument({ sourceCaptureRef: 'movie', durationMs: 4288,
            frameDurationMs: 1000 / 60, includeWindowText: false });
        const edited = reduceRecordingDocument(document, { kind: 'trim.set', startMs: 4088, endMs: 4288 });
        expect(reduceRecordingDocument(edited, { kind: 'trim.set', startMs: 4288, endMs: 4288 }).trim)
            .toEqual({ startMs: 4271, endMs: 4288 });
        expect(reduceRecordingDocument(edited, { kind: 'trim.set', startMs: 4088, endMs: 4088 }).trim)
            .toEqual({ startMs: 4088, endMs: 4105 });
        expect(reduceRecordingDocument(edited, { kind: 'trim.set', startMs: 100, endMs: 101 }).trim)
            .toEqual({ startMs: 100, endMs: 117 });
        expect(() => reduceRecordingDocument(edited, { kind: 'trim.set', startMs: 4200, endMs: 4100 })).toThrow(RangeError);
    });
    it('quantizes player gesture timestamps once to canonical integer milliseconds before native publication', () => {
        let document = createRecordingDocument({ frameDurationMs: 1000 / 25, sourceCaptureRef: 'movie', durationMs: 20_000.6, includeWindowText: false });
        document = reduceRecordingDocument(document, { kind: 'trim.set', startMs: 1_000.25, endMs: 10_000.75 });
        document = reduceRecordingDocument(document, { kind: 'pin.add', sourceTimeMs: 1.2345 * 1000 });
        document = reduceRecordingDocument(document, { kind: 'note.set', id: 'words', sourceTimeMs: 1.2345 * 1000, text: 'Nearest millisecond' });
        expect(document.durationMs).toBe(20_001);
        expect(document.trim).toEqual({ startMs: 1_000, endMs: 10_001 });
        expect(document.pins).toEqual([1_235]);
        expect(projectRecordingDocument(document).frames).toMatchObject([{ sourceTimeMs: 1_235, clipTimeMs: 235 }]);
    });
    it('shares blur transitions with window text while keeping explicit video restoration independent', () => {
        let document = createRecordingDocument({ frameDurationMs: 1000 / 25, sourceCaptureRef: 'movie', durationMs: 20_000, includeWindowText: true });
        const blurred = applyImageMarksOperations(empty, [{ kind: 'mark.add', mark: { id: 'secret', kind: 'blur',
            rect: { x: 0, y: 0, width: 10, height: 10 }, size: 'm' } }]);
        document = reduceRecordingDocument(document, { kind: 'frame.document', sourceTimeMs: 1_000, document: blurred, cause: 'edit' });
        expect(document.windowTextDisclosure).toEqual(document.videoDisclosure);
        expect(document.windowTextDisclosure.included).toBe(false);
        document = reduceRecordingDocument(document, { kind: 'includeVideo.set', mode: 'on' });
        document = reduceRecordingDocument(document, { kind: 'disclosure.warning', include: true });
        expect(document.videoDisclosure.included).toBe(true);
        expect(document.windowTextDisclosure.included).toBe(false);
        document = reduceRecordingDocument(document, { kind: 'windowText.set', included: true });
        expect(document.windowTextDisclosure.warning).toBe('pending');
        document = reduceRecordingDocument(document, { kind: 'windowText.warning', include: true });
        expect(document.windowTextDisclosure.included).toBe(true);
    });
    it('selects distinct source timestamps, rebases notes to trim-in and restores excluded edits on reset', () => {
        let document = createRecordingDocument({ frameDurationMs: 1000 / 25, sourceCaptureRef: 'movie', durationMs: 40_000, includeWindowText: false });
        document = reduceRecordingDocument(document, { kind: 'pin.add', sourceTimeMs: 10_000 });
        document = reduceRecordingDocument(document, { kind: 'pin.add', sourceTimeMs: 20_000 });
        document = reduceRecordingDocument(document, { kind: 'note.set', id: 'words', sourceTimeMs: 20_000, text: 'Identical pixels are still another moment' });
        document = reduceRecordingDocument(document, { kind: 'frame.document', sourceTimeMs: 20_000, document: marked, cause: 'edit' });
        document = reduceRecordingDocument(document, { kind: 'frame.document', sourceTimeMs: 30_000, document: marked, cause: 'edit' });
        const framesBeforeTrim = document.frames;
        const notesBeforeTrim = document.notes;
        document = reduceRecordingDocument(document, { kind: 'trim.set', startMs: 15_000, endMs: 35_000 });
        expect(projectRecordingDocument(document)).toMatchObject({ durationMs: 20_000, frames: [
            { sourceTimeMs: 20_000, clipTimeMs: 5_000, document: marked, notes: [{ id: 'words', text: 'Identical pixels are still another moment' }] },
            { sourceTimeMs: 30_000, clipTimeMs: 15_000, document: marked, notes: [] },
        ] });
        expect(document.frames).toBe(framesBeforeTrim);
        expect(document.notes).toBe(notesBeforeTrim);
        document = reduceRecordingDocument(document, { kind: 'trim.set', startMs: 25_000, endMs: 35_000 });
        expect(projectRecordingDocument(document).frames.map(frame => frame.sourceTimeMs)).toEqual([30_000]);
        document = reduceRecordingDocument(document, { kind: 'trim.reset' });
        expect(projectRecordingDocument(document).frames.map(frame => frame.sourceTimeMs)).toEqual([10_000, 20_000, 30_000]);
        expect(projectRecordingDocument(document).frames[1]?.notes[0]?.text).toBe('Identical pixels are still another moment');
    });

    it('uses a movable default only without explicit in-trim moments and keeps empty frame documents unselected', () => {
        let document = createRecordingDocument({ frameDurationMs: 1000 / 25, sourceCaptureRef: 'movie', durationMs: 20_000, includeWindowText: false });
        document = reduceRecordingDocument(document, { kind: 'trim.set', startMs: 8_000, endMs: 12_000 });
        expect(projectRecordingDocument(document).frames.map(frame => frame.sourceTimeMs)).toEqual([8_000]);
        document = reduceRecordingDocument(document, { kind: 'defaultPin.move', sourceTimeMs: 10_000 });
        document = reduceRecordingDocument(document, { kind: 'frame.document', sourceTimeMs: 11_000, document: empty, cause: 'edit' });
        expect(projectRecordingDocument(document).frames.map(frame => frame.sourceTimeMs)).toEqual([10_000]);
        document = reduceRecordingDocument(document, { kind: 'note.set', id: 'outside', sourceTimeMs: 2_000, text: 'Keep this outside the trim' });
        expect(projectRecordingDocument(document).frames.map(frame => frame.sourceTimeMs)).toEqual([10_000]);
        document = reduceRecordingDocument(document, { kind: 'pin.add', sourceTimeMs: 9_000 });
        expect(projectRecordingDocument(document).frames.map(frame => frame.sourceTimeMs)).toEqual([9_000]);
        document = reduceRecordingDocument(document, { kind: 'pin.remove', sourceTimeMs: 9_000 });
        expect(projectRecordingDocument(document).frames.map(frame => frame.sourceTimeMs)).toEqual([10_000]);
        document = reduceRecordingDocument(document, { kind: 'trim.reset' });
        expect(projectRecordingDocument(document).frames.map(frame => frame.sourceTimeMs)).toEqual([2_000]);
    });

    it('delegates committed frame marks and blur undo/redo to the annotation and shared disclosure owners', () => {
        let document = createRecordingDocument({ frameDurationMs: 1000 / 25, sourceCaptureRef: 'movie', durationMs: 20_000, includeWindowText: false });
        const commits: RecordingDocument[] = [];
        const annotator = createImageAnnotator({ source: { uri: 'blob:frame', ...empty.image }, initial: empty, tools: { crop: false },
            onDocumentChange: (frame, cause) => {
                document = reduceRecordingDocument(document, { kind: 'frame.document', sourceTimeMs: 2_000, document: frame, cause });
                commits.push(document);
            } });
        const blur = { id: 'private', kind: 'blur' as const, rect: { x: 0, y: 0, width: 20, height: 20 }, size: 'm' as const };
        annotator.apply([{ kind: 'mark.add', mark: blur }]);
        const expectedBlur = reduceCaptureDisclosure(createCaptureDisclosureState(true), { type: 'document', blurCount: 1, cause: 'edit' });
        expect(document.videoDisclosure).toEqual(expectedBlur);
        expect(projectRecordingDocument(document).includeVideo).toBe(false);
        annotator.undo();
        expect(projectRecordingDocument(document).includeVideo).toBe(true);
        annotator.redo();
        expect(projectRecordingDocument(document).includeVideo).toBe(false);
        document = reduceRecordingDocument(document, { kind: 'includeVideo.set', mode: 'on' });
        expect(document.videoDisclosure.warning).toBe('pending');
        expect(projectRecordingDocument(document).includeVideo).toBe(false);
        document = reduceRecordingDocument(document, { kind: 'disclosure.warning', include: true });
        expect(projectRecordingDocument(document).includeVideo).toBe(true);
        annotator.apply([{ kind: 'mark.add', mark: { ...blur, id: 'second' } }]);
        expect(projectRecordingDocument(document).includeVideo).toBe(false);
        annotator.undo();
        expect(projectRecordingDocument(document).includeVideo).toBe(true);
        expect(commits).toHaveLength(5);
        expect(readRecordingFrameDocument(document, 2_000)).toBe(annotator.store.getState().document);
    });

    it('shares headless mark operations, refuses frame crop and preserves unrelated edit identities', () => {
        let document = createRecordingDocument({ frameDurationMs: 1000 / 25, sourceCaptureRef: 'movie', durationMs: 20_000, includeWindowText: false });
        document = reduceRecordingDocument(document, { kind: 'note.set', id: 'words', sourceTimeMs: 1_000, text: 'Words' });
        const notes = document.notes;
        document = applyRecordingFrameOperations(document, 2_000, [{ kind: 'mark.add', mark: marked.marks[0]! }], empty.image);
        expect(readRecordingFrameDocument(document, 2_000)).toEqual(marked);
        expect(document.notes).toBe(notes);
        expect(reduceRecordingDocument(document, { kind: 'pin.remove', sourceTimeMs: 5_000 })).toBe(document);
        expect(reduceRecordingDocument(document, { kind: 'includeVideo.set', mode: 'auto' })).toBe(document);
        expect(() => applyRecordingFrameOperations(document, 2_000, [{ kind: 'crop.set', rect: { x: 0, y: 0, width: 10, height: 10 } }], empty.image)).toThrow(RangeError);
        expect(() => reduceRecordingDocument(document, { kind: 'trim.set', startMs: 10_000, endMs: 5_000 })).toThrow(RangeError);
    });
});
