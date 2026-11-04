import { applyImageMarksOperations, countBlurMarks, isEmptyEdit, type ImageMarksDocumentV1, type ImageMarksOperationV1 } from '@happier-dev/protocol/sessions/media/imageMarksV1';
import { createCaptureDisclosureState, reduceCaptureDisclosure, type CaptureDisclosureState } from '../disclosure/captureDisclosureRule';

export type RecordingNote = Readonly<{ id: string; sourceTimeMs: number; text: string }>;
export type RecordingFrame = Readonly<{ sourceTimeMs: number; document: ImageMarksDocumentV1 }>;
export type RecordingDocument = Readonly<{
    sourceCaptureRef: string;
    durationMs: number;
    frameDurationMs: number;
    trim: Readonly<{ startMs: number; endMs: number }>;
    defaultPinMs: number | null;
    pins: readonly number[];
    notes: readonly RecordingNote[];
    frames: readonly RecordingFrame[];
    includeVideo: 'auto' | 'on' | 'off';
    videoDisclosure: CaptureDisclosureState;
    windowTextDisclosure: CaptureDisclosureState;
}>;
export type RecordingOperation =
    | Readonly<{ kind: 'trim.set'; startMs: number; endMs: number }>
    | Readonly<{ kind: 'trim.reset' }>
    | Readonly<{ kind: 'defaultPin.move' | 'pin.add' | 'pin.remove'; sourceTimeMs: number }>
    | Readonly<{ kind: 'note.set'; id: string; sourceTimeMs: number; text: string }>
    | Readonly<{ kind: 'note.remove'; id: string }>
    | Readonly<{ kind: 'frame.document'; sourceTimeMs: number; document: ImageMarksDocumentV1; cause: 'edit' | 'undo' | 'redo' }>
    | Readonly<{ kind: 'includeVideo.set'; mode: RecordingDocument['includeVideo'] }>
    | Readonly<{ kind: 'disclosure.warning'; include: boolean }>
    | Readonly<{ kind: 'disclosure.input' }>
    | Readonly<{ kind: 'windowText.set'; included: boolean }>
    | Readonly<{ kind: 'windowText.warning'; include: boolean }>
    | Readonly<{ kind: 'windowText.input' }>;
export type RecordingSelectedFrame = Readonly<{
    sourceTimeMs: number; clipTimeMs: number; document: ImageMarksDocumentV1 | null; notes: readonly RecordingNote[];
}>;

/** Player gestures are fractional seconds; every stored/native timestamp has one millisecond unit. */
export function toRecordingTimeMs(value: number): number {
    if (!Number.isFinite(value) || value < 0) throw new RangeError('Invalid recording timestamp');
    return Math.round(value);
}

export function createRecordingDocument(input: Readonly<{ sourceCaptureRef: string; durationMs: number; frameDurationMs: number; includeWindowText: boolean }>): RecordingDocument {
    if (!input.sourceCaptureRef.trim()) throw new RangeError('Invalid recording source');
    const durationMs = toRecordingTimeMs(input.durationMs);
    if (durationMs === 0 || !Number.isFinite(input.frameDurationMs) || input.frameDurationMs <= 0) throw new RangeError('Invalid recording timing');
    return { sourceCaptureRef: input.sourceCaptureRef, durationMs, frameDurationMs: input.frameDurationMs,
        trim: { startMs: 0, endMs: durationMs }, defaultPinMs: null,
        pins: [], notes: [], frames: [], includeVideo: 'auto', videoDisclosure: createCaptureDisclosureState(true),
        windowTextDisclosure: createCaptureDisclosureState(input.includeWindowText) };
}

function requireSourceTime(document: RecordingDocument, value: number): number {
    const sourceTimeMs = toRecordingTimeMs(value);
    if (sourceTimeMs > document.durationMs) throw new RangeError('Timestamp outside recording source');
    return sourceTimeMs;
}

/** The source document retains excluded edits; projection alone decides which moments leave the clip. */
export function reduceRecordingDocument(document: RecordingDocument, operation: RecordingOperation): RecordingDocument {
    if ('sourceTimeMs' in operation) operation = { ...operation, sourceTimeMs: requireSourceTime(document, operation.sourceTimeMs) };
    switch (operation.kind) {
        case 'trim.set': {
            let startMs = requireSourceTime(document, operation.startMs);
            let endMs = requireSourceTime(document, operation.endMs);
            // Stored times are integer milliseconds, so round the media's own
            // frame duration upwards rather than admitting less than one frame.
            const frameMs = Math.min(document.durationMs, Math.ceil(document.frameDurationMs));
            if (endMs === document.trim.endMs) {
                startMs = Math.min(startMs, endMs - frameMs);
            } else if (startMs === document.trim.startMs) {
                endMs = Math.max(endMs, startMs + frameMs);
            } else {
                if (startMs > endMs) throw new RangeError('Reversed recording trim');
                startMs = Math.min(startMs, document.durationMs - frameMs);
                endMs = Math.max(endMs, startMs + frameMs);
            }
            if (document.trim.startMs === startMs && document.trim.endMs === endMs) return document;
            return { ...document, trim: { startMs, endMs } };
        }
        case 'trim.reset':
            return reduceRecordingDocument(document, { kind: 'trim.set', startMs: 0, endMs: document.durationMs });
        case 'defaultPin.move':
            return document.defaultPinMs === operation.sourceTimeMs ? document : { ...document, defaultPinMs: operation.sourceTimeMs };
        case 'pin.add':
            return document.pins.includes(operation.sourceTimeMs) ? document
                : { ...document, pins: [...document.pins, operation.sourceTimeMs] };
        case 'pin.remove':
            return !document.pins.includes(operation.sourceTimeMs) ? document
                : { ...document, pins: document.pins.filter(time => time !== operation.sourceTimeMs) };
        case 'note.set': {
            if (!operation.text) return reduceRecordingDocument(document, { kind: 'note.remove', id: operation.id });
            const previous = document.notes.find(note => note.id === operation.id);
            if (previous?.sourceTimeMs === operation.sourceTimeMs && previous.text === operation.text) return document;
            const next = { id: operation.id, sourceTimeMs: operation.sourceTimeMs, text: operation.text };
            return { ...document, notes: previous ? document.notes.map(note => note === previous ? next : note) : [...document.notes, next] };
        }
        case 'note.remove':
            return !document.notes.some(note => note.id === operation.id) ? document
                : { ...document, notes: document.notes.filter(note => note.id !== operation.id) };
        case 'frame.document': {
            if (operation.document.crop) throw new RangeError('Recording frame crop is unavailable');
            const previous = document.frames.find(frame => frame.sourceTimeMs === operation.sourceTimeMs);
            if (previous?.document === operation.document) return document;
            const next = { sourceTimeMs: operation.sourceTimeMs, document: operation.document };
            const blurCount = document.videoDisclosure.blurCount - (previous ? countBlurMarks(previous.document) : 0)
                + countBlurMarks(operation.document);
            return { ...document, frames: previous ? document.frames.map(frame => frame === previous ? next : frame) : [...document.frames, next],
                videoDisclosure: reduceCaptureDisclosure(document.videoDisclosure, { type: 'document', blurCount, cause: operation.cause }),
                windowTextDisclosure: reduceCaptureDisclosure(document.windowTextDisclosure, { type: 'document', blurCount, cause: operation.cause }) };
        }
        case 'includeVideo.set': {
            const included = operation.mode === 'on' || (operation.mode === 'auto' && document.videoDisclosure.blurCount === 0);
            const videoDisclosure = reduceCaptureDisclosure(document.videoDisclosure, { type: 'toggle', included });
            return operation.mode === document.includeVideo && videoDisclosure === document.videoDisclosure ? document
                : { ...document, includeVideo: operation.mode, videoDisclosure };
        }
        case 'disclosure.warning': {
            const videoDisclosure = reduceCaptureDisclosure(document.videoDisclosure, { type: 'warning', include: operation.include });
            return videoDisclosure === document.videoDisclosure ? document : { ...document, videoDisclosure };
        }
        case 'disclosure.input': {
            const videoDisclosure = reduceCaptureDisclosure(document.videoDisclosure, { type: 'input' });
            return videoDisclosure === document.videoDisclosure ? document : { ...document, videoDisclosure };
        }
        case 'windowText.set': {
            const windowTextDisclosure = reduceCaptureDisclosure(document.windowTextDisclosure, { type: 'toggle', included: operation.included });
            return windowTextDisclosure === document.windowTextDisclosure ? document : { ...document, windowTextDisclosure };
        }
        case 'windowText.warning': {
            const windowTextDisclosure = reduceCaptureDisclosure(document.windowTextDisclosure, { type: 'warning', include: operation.include });
            return windowTextDisclosure === document.windowTextDisclosure ? document : { ...document, windowTextDisclosure };
        }
        case 'windowText.input': {
            const windowTextDisclosure = reduceCaptureDisclosure(document.windowTextDisclosure, { type: 'input' });
            return windowTextDisclosure === document.windowTextDisclosure ? document : { ...document, windowTextDisclosure };
        }
    }
}

/** Pointer previews and keyboard commits use the same trim operation as Actions. */
export function moveRecordingTrim(document: RecordingDocument, edge: 'start' | 'end', timeMs: number): RecordingDocument['trim'] {
    if (!Number.isFinite(timeMs)) throw new RangeError('Invalid recording timestamp');
    const bounded = Math.max(0, Math.min(document.durationMs, timeMs));
    return reduceRecordingDocument(document, { kind: 'trim.set',
        startMs: edge === 'start' ? bounded : document.trim.startMs,
        endMs: edge === 'end' ? bounded : document.trim.endMs }).trim;
}

export function projectRecordingDocument(document: RecordingDocument): Readonly<{ durationMs: number; includeVideo: boolean; defaultPinMs: number | null; frames: readonly RecordingSelectedFrame[] }> {
    const inTrim = (time: number) => time >= document.trim.startMs && time <= document.trim.endMs;
    const selected = new Set<number>();
    for (const time of document.pins) if (inTrim(time)) selected.add(time);
    const notes = new Map<number, RecordingNote[]>();
    for (const note of document.notes) {
        if (!inTrim(note.sourceTimeMs)) continue;
        selected.add(note.sourceTimeMs);
        const atTime = notes.get(note.sourceTimeMs);
        if (atTime) atTime.push(note); else notes.set(note.sourceTimeMs, [note]);
    }
    const frames = new Map<number, ImageMarksDocumentV1>();
    for (const frame of document.frames) {
        if (!inTrim(frame.sourceTimeMs)) continue;
        frames.set(frame.sourceTimeMs, frame.document);
        if (!isEmptyEdit(frame.document)) selected.add(frame.sourceTimeMs);
    }
    const defaultPinMs = selected.size ? null : document.defaultPinMs !== null && inTrim(document.defaultPinMs)
        ? document.defaultPinMs : document.trim.startMs;
    if (defaultPinMs !== null) selected.add(defaultPinMs);
    return { durationMs: document.trim.endMs - document.trim.startMs, includeVideo: document.videoDisclosure.included,
        defaultPinMs,
        frames: [...selected].sort((a, b) => a - b).map(sourceTimeMs => ({ sourceTimeMs,
            clipTimeMs: sourceTimeMs - document.trim.startMs, document: frames.get(sourceTimeMs) ?? null,
            notes: notes.get(sourceTimeMs) ?? [] })) };
}
export function readRecordingFrameDocument(document: RecordingDocument, sourceTimeMs: number): ImageMarksDocumentV1 | null {
    const time = requireSourceTime(document, sourceTimeMs);
    return document.frames.find(frame => frame.sourceTimeMs === time)?.document ?? null;
}
export function applyRecordingFrameOperations(document: RecordingDocument, sourceTimeMs: number,
    operations: readonly ImageMarksOperationV1[], image: ImageMarksDocumentV1['image'], cause: 'edit' | 'undo' | 'redo' = 'edit'): RecordingDocument {
    const initial = readRecordingFrameDocument(document, sourceTimeMs) ?? { v: 1 as const, image, marks: [] };
    const frame = applyImageMarksOperations(initial, operations);
    return frame === initial ? document : reduceRecordingDocument(document, { kind: 'frame.document', sourceTimeMs, document: frame, cause });
}
