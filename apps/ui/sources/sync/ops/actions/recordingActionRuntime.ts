import { hasBlur, isEmptyEdit, type ImageMarksOperationV1 } from '@happier-dev/protocol/sessions/media/imageMarksV1';
import type { z } from 'zod/mini';
import type { ScreenCaptureRecordingEditInputSchema, ScreenCaptureRecordingReadInputSchema } from '@happier-dev/protocol/actions/actionSpecs';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import { NativeCaptureError, loadNativeRecordingDocument, readCaptureResult, writeNativeRecordingDocument } from '@/desktop/capture/nativeCapture';
import { applyRecordingFrameOperations, projectRecordingDocument, readRecordingFrameDocument, reduceRecordingDocument,
    type RecordingDocument } from '@/components/screenCapture/recording/recordingDocument';

function metadata(document: RecordingDocument) {
    const projection = projectRecordingDocument(document);
    return { captureRef: document.sourceCaptureRef, durationMs: document.durationMs, trim: document.trim,
        pins: document.pins, notes: document.notes, includeVideo: document.includeVideo,
        videoIncluded: projection.includeVideo, windowTextIncluded: document.windowTextDisclosure.included,
        frames: projection.frames.map(frame => ({ sourceTimeMs: frame.sourceTimeMs, timeMs: frame.clipTimeMs,
            hasMarks: frame.document !== null && !isEmptyEdit(frame.document),
            hasBlur: frame.document !== null && hasBlur(frame.document) })) };
}

export async function executeRecordingDocumentAction(request: Readonly<{
    actionId: 'screenCapture.recording.edit' | 'screenCapture.recording.read';
    input: unknown;
    context: ActionExecutorContext;
    signal?: AbortSignal;
}>) {
    const input = request.input as z.infer<typeof ScreenCaptureRecordingReadInputSchema>;
    let document = await loadNativeRecordingDocument(input.captureRef);
    if (request.actionId === 'screenCapture.recording.edit') {
        const edit = request.input as z.infer<typeof ScreenCaptureRecordingEditInputSchema>;
        try {
            const next = edit.operations.reduce(reduceRecordingDocument, document);
            if (next !== document) document = await writeNativeRecordingDocument(input.captureRef, next, { expectedDocument: document });
        } catch (error) {
            if (error instanceof RangeError) return { ok: false as const, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
            throw error;
        }
    }
    const result = metadata(document);
    if (request.actionId === 'screenCapture.recording.read' && input.frameAtMs !== undefined) {
        const { readRecordingDeliveryFrame } = await import('./prepareRecordingDelivery');
        try {
            const frame = await readRecordingDeliveryFrame(input.captureRef, input.frameAtMs, request.signal);
            return 'ok' in frame ? frame : { ...result, frame };
        } catch (error) {
            if (error instanceof RangeError) return { ok: false as const, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
            throw error;
        }
    }
    return result;
}

/** P2 owns mark operations/history; this adapter addresses the same P3 recording document. */
export async function executeRecordingFrameAnnotation(target: Readonly<{ captureRef: string; sourceTimeMs: number }>,
    operations: readonly ImageMarksOperationV1[] | null, cause: 'edit' | 'undo' | 'redo' = 'edit') {
    try {
        const result = await readCaptureResult(target.captureRef);
        if (result.kind !== 'video') return { status: 'unavailable' as const, reason: 'annotation.targetUnavailable' as const };
        const document = await loadNativeRecordingDocument(target.captureRef);
        if (target.sourceTimeMs > document.durationMs) return { status: 'unavailable' as const, reason: 'annotation.targetUnavailable' as const };
        const image = { ...result.pixelSize, scale: result.scale ?? 1 };
        if (operations === null) {
            const frame = readRecordingFrameDocument(document, target.sourceTimeMs);
            return { ...(frame ? { document: frame } : {}), image, hasBlur: frame !== null && hasBlur(frame) };
        }
        const next = applyRecordingFrameOperations(document, target.sourceTimeMs, operations, image, cause);
        if (next !== document) await writeNativeRecordingDocument(target.captureRef, next, { expectedDocument: document });
        const frame = readRecordingFrameDocument(next, target.sourceTimeMs);
        return { status: frame === null || isEmptyEdit(frame) ? 'reverted' as const : 'replaced' as const };
    } catch (error) {
        const code = error instanceof NativeCaptureError ? error.code : error instanceof RangeError ? 'invalid_parameters' : null;
        if (code) return { ok: false as const, errorCode: code, error: code };
        throw error;
    }
}
