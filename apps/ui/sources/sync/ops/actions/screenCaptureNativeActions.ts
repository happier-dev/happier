import type { z } from 'zod/mini';
import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/actionExecutor';
import type { ScreenCapturePermissionRequestInputSchema,
    ScreenCaptureWindowTextInputSchema, ScreenCaptureRecordingInputSchema } from '@happier-dev/protocol/actions/actionSpecs';
import { listNativeCaptureTargets, readNativeCapturePermissions,
    requestNativeCapturePermission, readNativeCaptureWindowText, listRecentCaptures,
    readNativeRecordingStatus, pauseNativeRecording, resumeNativeRecording, stopNativeRecording } from '@/desktop/capture/nativeCapture';
import { executeRecordingDocumentAction } from './recordingActionRuntime';

/** Inputs have been admitted by the shared Action executor before any OS read or acquisition. */
export async function executeNativeScreenCaptureAction(
    { actionId, input, context }: Parameters<NonNullable<ActionExecutorDeps['screenCaptureAction']>>[0],
): Promise<unknown> {
    context.signal?.throwIfAborted();
    switch (actionId) {
        case 'screenCapture.recording.status':
            return readNativeRecordingStatus((input as z.infer<typeof ScreenCaptureRecordingInputSchema>).operationRef);
        case 'screenCapture.recording.pause':
            return pauseNativeRecording((input as z.infer<typeof ScreenCaptureRecordingInputSchema>).operationRef);
        case 'screenCapture.recording.resume':
            return resumeNativeRecording((input as z.infer<typeof ScreenCaptureRecordingInputSchema>).operationRef);
        case 'screenCapture.recording.stop':
            return stopNativeRecording((input as z.infer<typeof ScreenCaptureRecordingInputSchema>).operationRef);
        case 'screenCapture.recording.edit':
        case 'screenCapture.recording.read':
            return executeRecordingDocumentAction({ actionId, input, context, ...(context.signal ? { signal: context.signal } : {}) });
        case 'screenCapture.targets.list':
            return listNativeCaptureTargets();
        case 'screenCapture.permissions.read':
            return readNativeCapturePermissions();
        case 'screenCapture.permissions.request':
            return requestNativeCapturePermission((input as z.infer<typeof ScreenCapturePermissionRequestInputSchema>).subject);
        case 'screenCapture.windowText.read': {
            const { captureRef } = input as z.infer<typeof ScreenCaptureWindowTextInputSchema>;
            return { captureRef, ...await readNativeCaptureWindowText(captureRef) };
        }
        case 'screenCapture.recent.list':
            return listRecentCaptures();
        default:
            return undefined;
    }
}
