import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/actionExecutor';
import { readCaptureDeliveryState, readCaptureResult, readCaptureSourcePng, readPreparedCapturePng, retainPreparedCapturePng,
    type NativeCaptureWindowText } from '@/desktop/capture/nativeCapture';
import { leafFolderName } from '@/utils/path/pathUtils';
import { t } from '@/text';
import type { RecordingDeliverySource } from './prepareRecordingDelivery';
import type { SavedAttachmentFile } from '@/sync/domains/attachments/attachmentsUploadFileSource';

type CaptureDeliveryImage = Readonly<{ kind: 'original' | 'prepared'; name: string; previewUri?: string; savedFile?: SavedAttachmentFile;
    readForDraft?: () => Promise<Readonly<{ bytes: Uint8Array; savedFile: SavedAttachmentFile }>> }>
    & (Readonly<{ bytes: Uint8Array }> | Readonly<{ readBytes: () => Promise<Uint8Array> }>);
type CaptureDeliveryContext = Readonly<{
    captureRef: string;
    disclosure: Readonly<{ hasMarks?: boolean; includeWindowText: boolean }> | null;
    windowText?: Readonly<{ text: string; name: string }>;
    readWindowText?: () => Promise<Readonly<{ text: string; name: string }> | undefined>;
    inUse: boolean;
}>;
export type StillDeliveryRecord = CaptureDeliveryContext & Readonly<{ image: CaptureDeliveryImage }>;
export type CaptureDeliveryRecord = StillDeliveryRecord
    | (CaptureDeliveryContext & Readonly<{ recording: RecordingDeliverySource }>);
export type StillDelivery = Pick<CaptureDeliveryContext, 'windowText' | 'readWindowText'> & Readonly<{ image: CaptureDeliveryImage }>;
export type RecordingDelivery = Readonly<{ recording: RecordingDeliverySource }>;

/** Retain before reading so staged and restored bytes have one immutable source. */
export async function readCaptureImageForDraft(captureRef: string): Promise<Readonly<{ bytes: Uint8Array; savedFile: SavedAttachmentFile }>> {
    const retained = await retainPreparedCapturePng(captureRef);
    return { bytes: await readCaptureSourcePng(retained.captureRef),
        savedFile: { kind: 'capture', captureRef: retained.captureRef, content: 'source' } };
}

/** L5 is shared by draft delivery and every image clipboard consumer. */
export function resolveCaptureDelivery(record: StillDeliveryRecord, context: Pick<ActionExecutorContext, 'surface'>,
    options?: Readonly<{ captureWindowPress?: boolean }>): ActionExecuteFailure | StillDelivery;
export function resolveCaptureDelivery(record: CaptureDeliveryRecord, context: Pick<ActionExecutorContext, 'surface'>,
    options?: Readonly<{ captureWindowPress?: boolean }>): ActionExecuteFailure | StillDelivery | RecordingDelivery;
export function resolveCaptureDelivery(record: CaptureDeliveryRecord, context: Pick<ActionExecutorContext, 'surface'>,
    options: Readonly<{ captureWindowPress?: boolean }> = {}): ActionExecuteFailure | StillDelivery | RecordingDelivery {
    const failure = (errorCode: string): ActionExecuteFailure => ({ ok: false, errorCode, error: errorCode });
    if (record.inUse && !(context.surface === 'ui' && options.captureWindowPress)) return failure('capture_in_use');
    if ('recording' in record) return { recording: record.recording };
    if (!record.disclosure) return failure('capture_not_prepared');
    if (record.disclosure.hasMarks !== false && record.image.kind !== 'prepared') return failure('capture_not_prepared');
    return { image: record.image,
        ...(record.disclosure.includeWindowText && record.windowText ? { windowText: record.windowText } : {}),
        ...(record.disclosure.includeWindowText && record.readWindowText ? { readWindowText: record.readWindowText } : {}) };
}

export function captureWindowTextAttachment(outcome: NativeCaptureWindowText | null | undefined): StillDelivery['windowText'] {
    const text = outcome?.status === 'ready' || outcome?.status === 'partial' ? outcome : null;
    const label = t('screenCapture.window.wholeWindowText');
    return text ? { text: text.text, name: `${label}${text.source?.appName ? ` — ${text.source.appName}` : ''}.txt` } : undefined;
}

/** Native references, not renderer events, carry prepared content to its admitted consumer. */
export async function readPreparedCaptureDelivery(captureRef: string): Promise<CaptureDeliveryRecord> {
    const [result, state] = await Promise.all([readCaptureResult(captureRef), readCaptureDeliveryState(captureRef)]);
    if (result.kind === 'video') return { captureRef, inUse: state.inUse, disclosure: state.disclosure,
        recording: { result, prepared: state.preparedRecording } };
    const windowText = captureWindowTextAttachment(state.windowText);
    return { captureRef, inUse: state.inUse, disclosure: state.disclosure,
        ...(windowText ? { windowText } : {}), image: { kind: 'prepared', name: leafFolderName(result.path) ?? 'Capture.png',
            readBytes: () => readPreparedCapturePng(captureRef), readForDraft: () => readCaptureImageForDraft(captureRef) } };
}
