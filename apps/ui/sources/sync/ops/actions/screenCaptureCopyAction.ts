import type { z } from 'zod/mini';
import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/actionExecutor';
import type { ScreenCaptureCopyInputSchema } from '@happier-dev/protocol/actions/actionSpecs';
import { NativeCaptureError, readNativeCaptureWindowText } from '@/desktop/capture/nativeCapture';
import { encodeBase64 } from '@/encryption/base64';
import { isDesktopHost } from '@/utils/platform/desktopHost';
import { setClipboardImageSafe, setClipboardStringSafe } from '@/utils/ui/clipboard';
import { readPreparedCaptureDelivery, resolveCaptureDelivery, type CaptureDeliveryRecord } from './screenCaptureDelivery';

export type CaptureCopyInput = z.infer<typeof ScreenCaptureCopyInputSchema>;
export type CaptureClipboardPort = Readonly<{
    image: (png: Uint8Array) => Promise<boolean>;
    text: (text: string) => Promise<boolean>;
}>;
const PLATFORM_CLIPBOARD: CaptureClipboardPort = {
    image: png => setClipboardImageSafe(encodeBase64(png)), text: setClipboardStringSafe,
};
const failure = (errorCode: string): ActionExecuteFailure => ({ ok: false, errorCode, error: errorCode });

/** The admitted copy owner for main/agents and the gesture-bound Capture UI capability. No Sync. */
export async function executeScreenCaptureCopy(
    { input, context }: Parameters<NonNullable<ActionExecutorDeps['screenCaptureAction']>>[0],
    options: Readonly<{
        captureWindowPress?: boolean;
        prepare?: () => Promise<void | ActionExecuteFailure>;
        clipboard?: CaptureClipboardPort;
        readDelivery?: (captureRef: string) => Promise<CaptureDeliveryRecord | ActionExecuteFailure>;
    }> = {},
) {
    if (!isDesktopHost()) return failure('desktop_only');
    const parsed = input as CaptureCopyInput;
    const clipboard = options.clipboard ?? PLATFORM_CLIPBOARD;
    try {
        context.signal?.throwIfAborted();
        const refused = await options.prepare?.();
        if (refused) return refused;
        let copied: boolean;
        if (parsed.content === 'windowText') {
            // Explicit Copy text is independent of the checkbox for sending text with an image.
            const text = await readNativeCaptureWindowText(parsed.captureRef);
            if (text.status === 'unavailable') return failure(text.reason);
            copied = await clipboard.text(text.status === 'empty' ? '' : text.text);
        } else {
            const record = await (options.readDelivery ?? readPreparedCaptureDelivery)(parsed.captureRef);
            if ('ok' in record) return record;
            const delivery = resolveCaptureDelivery(record, context, options);
            if ('ok' in delivery) return delivery;
            let png: Uint8Array;
            if ('recording' in delivery) {
                const prepared = await (await import('./prepareRecordingDelivery')).prepareRecordingDelivery(delivery.recording,
                    { imageOnly: true, frameAtMs: parsed.frameAtMs, signal: context.signal });
                if ('ok' in prepared) return prepared;
                png = prepared.images[0]!.bytes;
            } else {
                if (parsed.frameAtMs !== undefined) return failure('invalid_parameters');
                png = 'bytes' in delivery.image ? delivery.image.bytes : await delivery.image.readBytes();
            }
            context.signal?.throwIfAborted();
            copied = await clipboard.image(png);
        }
        return copied ? { captureRef: parsed.captureRef, status: 'copied' as const } : failure('clipboard_unavailable');
    } catch (error) {
        if (error instanceof NativeCaptureError) return failure(error.code);
        if (error instanceof RangeError) return failure('invalid_parameters');
        throw error;
    }
}
