import { hasBlur } from '@happier-dev/protocol/sessions/media/imageMarksV1';
import { type MediaAnnotationActionRequestV1, type MediaAnnotationApplyResultV1, type MediaAnnotationReadResultV1 } from '@happier-dev/protocol/actions/mediaAnnotationAction';
import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ImageAnnotator } from '@/components/ui/media/annotation/types';
import { invokeDesktopHost, isDesktopHost, listenDesktopHostEvent } from '@/utils/platform/desktopHost';

type AnnotationResult = MediaAnnotationReadResultV1 | MediaAnnotationApplyResultV1 | ActionExecuteFailure;
type AnnotationRequest = Readonly<{ captureRef: string; requestId: number; request: MediaAnnotationActionRequestV1 }>;
const unavailable = { status: 'unavailable', reason: 'annotation.targetUnavailable' } as const;

/** Main has already admitted the Account-scoped Action; native resolves its exact live window. */
export function requestCaptureAnnotationAction(captureRef: string, request: MediaAnnotationActionRequestV1): Promise<AnnotationResult> {
    if (!isDesktopHost()) return Promise.resolve({ ok: false, errorCode: 'desktop_only', error: 'desktop_only' });
    return invokeDesktopHost<AnnotationResult>('desktop_capture_annotation_request', {
        captureRef, request: { actionId: request.actionId, input: request.input },
    });
}

/** Binds the actual editor, without copying its marks. Native owns readiness and in-flight replies. */
export async function registerCaptureAnnotationTarget(input: Readonly<{
    captureRef: string;
    annotator: ImageAnnotator;
    signal: AbortSignal;
}>): Promise<void> {
    if (input.signal.aborted) return;
    const unsubscribe = await listenDesktopHostEvent<AnnotationRequest>('desktopCapture://annotation-request', event => {
        if (event.captureRef !== input.captureRef) return;
        let result: AnnotationResult = unavailable;
        const { request } = event;
        if (!input.signal.aborted && request.input.target.kind === 'capture' && request.input.target.captureRef === input.captureRef) {
            if (request.actionId === 'media.annotation.read') {
                const document = input.annotator.store.getState().document;
                result = { document, image: document.image, hasBlur: hasBlur(document) };
            } else {
                try {
                    input.annotator.apply(request.input.reset ? [{ kind: 'reset' }] : request.input.operations!);
                    result = { status: request.input.reset ? 'reverted' : 'replaced' };
                } catch {
                    result = { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
                }
            }
        }
        void invokeDesktopHost<void>('desktop_capture_annotation_result', {
            captureRef: input.captureRef, requestId: event.requestId, result,
        }).catch(() => undefined);
    });
    if (input.signal.aborted) { unsubscribe(); return; }
    const ready = invokeDesktopHost<void>('desktop_capture_annotation_ready', { captureRef: input.captureRef, ready: true });
    const stop = () => {
        unsubscribe();
        // Keep false after true even when the editor unmounts while readiness crosses IPC.
        void ready.then(() => invokeDesktopHost<void>('desktop_capture_annotation_ready', {
            captureRef: input.captureRef, ready: false,
        })).catch(() => undefined);
    };
    input.signal.addEventListener('abort', stop, { once: true });
    try { await ready; }
    catch (error) {
        input.signal.removeEventListener('abort', stop);
        unsubscribe();
        throw error;
    }
}
