import { isEmptyEdit } from '@happier-dev/protocol/sessions/media/imageMarksV1';
import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import { flattenAnnotatedImage } from '@/components/ui/media/annotation/flattenImage';
import { withVideoFrameSource, type MediaPlayerVideoControls } from '@/components/workspaces/files/file/videoFrameAccess';
import { formatPlaybackTime } from '@/components/workspaces/files/file/filePageMediaFacts';
import { projectRecordingDocument, readRecordingFrameDocument, toRecordingTimeMs, type RecordingDocument, type RecordingSelectedFrame } from '@/components/screenCapture/recording/recordingDocument';
import { loadNativeRecordingDocument, prepareNativeRecording, readCaptureResult, readCaptureSource, readPreparedCapturePng,
    readNativeCaptureWindowText, trimNativeRecording, type NativeCaptureResult, type NativeCaptureWindowText,
    type NativePreparedRecording } from '@/desktop/capture/nativeCapture';
import { leafFolderName } from '@/utils/path/pathUtils';
import type { SavedAttachmentFile } from '@/sync/domains/attachments/attachmentsUploadFileSource';

export type RecordingDeliverySource = Readonly<{
    result: NativeCaptureResult; document?: RecordingDocument; prepared?: NativePreparedRecording | null;
}>;
export type PreparedRecordingDelivery = Readonly<{
    images: readonly Readonly<{ name: string; bytes: Uint8Array; note: string; savedFile: SavedAttachmentFile }>[];
    video?: Readonly<{ name: string; bytes: Uint8Array; mimeType: string; savedFile: SavedAttachmentFile }>;
    windowText?: NativeCaptureWindowText;
    summary: Readonly<{ frameCount: number; durationMs: number; byteSize: number; includeVideo: boolean }>;
}>;

function frameNote(frame: RecordingSelectedFrame, pinned: boolean): string {
    const milliseconds = String(Math.floor(frame.clipTimeMs % 1000)).padStart(3, '0');
    const timestamp = `${formatPlaybackTime(frame.clipTimeMs / 1000)}.${milliseconds}`;
    const additions = [
        ...(pinned ? ['pin'] : []),
        ...frame.notes.map(note => `note: ${JSON.stringify(note.text)}`),
        ...(frame.document && !isEmptyEdit(frame.document)
            ? [`marked frame: ${frame.document.marks.map(mark => mark.kind).join(', ')}`] : []),
    ];
    return additions.length ? `${timestamp} — ${additions.join('; ')}` : timestamp;
}

async function drawFrames(source: RecordingDeliverySource, selected: readonly RecordingSelectedFrame[],
    signal?: AbortSignal, controls?: MediaPlayerVideoControls, pins: ReadonlySet<number> = new Set()) {
    signal?.throwIfAborted();
    const draw = async (player: MediaPlayerVideoControls) => {
        const frames = [];
        for (const frame of selected) {
            signal?.throwIfAborted();
            const decoded = await player.readFrame({ timeSeconds: frame.sourceTimeMs / 1000, signal });
            let bytes: Uint8Array;
            if (frame.document && !isEmptyEdit(frame.document)) {
                const flattened = await flattenAnnotatedImage({ uri: decoded.uri, width: decoded.width, height: decoded.height,
                    scale: frame.document.image.scale }, frame.document);
                if (!flattened.ok) return { ok: false as const, errorCode: flattened.reason, error: flattened.reason };
                bytes = flattened.png;
            } else bytes = decodeBase64(decoded.uri.slice('data:image/png;base64,'.length));
            signal?.throwIfAborted();
            frames.push({ timeMs: frame.clipTimeMs, bytes, note: frameNote(frame, pins.has(frame.sourceTimeMs)), width: decoded.width, height: decoded.height });
        }
        return frames;
    };
    if (controls) return draw(controls);
    const bytes = await readCaptureSource(source.result.captureRef);
    signal?.throwIfAborted();
    const uri = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: source.result.mimeType }));
    try { return await withVideoFrameSource(uri, draw, signal); }
    finally { URL.revokeObjectURL(uri); }
}

type RecordingPreparationOptions = Readonly<{
    imageOnly?: boolean; frameAtMs?: number; signal?: AbortSignal; controls?: MediaPlayerVideoControls;
}>;

/** One pixel/flatten owner; the visible Capture player writes native refs before main intake. */
export async function prepareNativeRecordingDelivery(source: RecordingDeliverySource, options: RecordingPreparationOptions = {}):
    Promise<NativePreparedRecording | ActionExecuteFailure> {
    options.signal?.throwIfAborted();
    const document = source.document ?? await loadNativeRecordingDocument(source.result.captureRef);
    const projection = projectRecordingDocument(document);
    const selected = options.frameAtMs === undefined ? (options.imageOnly ? projection.frames.slice(0, 1) : projection.frames)
        : [{ sourceTimeMs: options.frameAtMs, clipTimeMs: options.frameAtMs - document.trim.startMs,
            document: readRecordingFrameDocument(document, options.frameAtMs), notes: [] }];
    const pins = new Set(document.pins);
    if (projection.defaultPinMs !== null) pins.add(projection.defaultPinMs);
    const frames = await drawFrames(source, selected, options.signal, options.controls, pins);
    if ('ok' in frames) return frames;
    const includeVideo = !options.imageOnly && projection.includeVideo;
    let video = source.result;
    if (includeVideo && (document.trim.startMs !== 0 || document.trim.endMs !== document.durationMs
        || !['video/mp4', 'video/webm'].includes(video.mimeType))) {
        video = await trimNativeRecording(source.result.captureRef, document.trim.startMs, document.trim.endMs, options.signal);
    }
    options.signal?.throwIfAborted();
    const prepared = await prepareNativeRecording({ captureRef: source.result.captureRef, frames,
        ...(includeVideo ? { videoRef: video.captureRef } : {}), includeVideo,
        hasMarks: selected.some(frame => frame.document !== null && !isEmptyEdit(frame.document)),
        includeWindowText: document.windowTextDisclosure.included });
    options.signal?.throwIfAborted();
    return prepared;
}

/** Native owns invalidation on edit or failed replacement; intake never decodes these refs. */
export async function readPreparedRecordingDelivery(source: RecordingDeliverySource, options: Readonly<{
    imageOnly?: boolean; signal?: AbortSignal;
}> = {}): Promise<PreparedRecordingDelivery | ActionExecuteFailure> {
    options.signal?.throwIfAborted();
    const prepared = source.prepared;
    if (!prepared) return { ok: false, errorCode: 'capture_not_prepared', error: 'capture_not_prepared' };
    const document = source.document ?? await loadNativeRecordingDocument(source.result.captureRef);
    const images = await Promise.all(prepared.frames.map(async frame => ({
        name: `Frame-${frame.timeMs}.png`, bytes: await readPreparedCapturePng(frame.frameRef), note: frame.note ?? '',
        savedFile: { kind: 'capture' as const, captureRef: frame.frameRef, content: 'prepared' as const },
    })));
    let outgoingVideo: PreparedRecordingDelivery['video'];
    if (prepared.videoRef) {
        const video = prepared.videoRef === source.result.captureRef ? source.result : await readCaptureResult(prepared.videoRef);
        outgoingVideo = { name: leafFolderName(video.path) ?? 'Recording.mp4', mimeType: video.mimeType,
            bytes: await readCaptureSource(prepared.videoRef), savedFile: { kind: 'capture', captureRef: prepared.videoRef, content: 'source' } };
    }
    const windowText = !options.imageOnly && document.windowTextDisclosure.included
        ? await readNativeCaptureWindowText(source.result.captureRef) : undefined;
    options.signal?.throwIfAborted();
    return { images, ...(outgoingVideo ? { video: outgoingVideo } : {}), ...(windowText ? { windowText } : {}),
        summary: { frameCount: prepared.frames.length, durationMs: document.trim.endMs - document.trim.startMs,
            byteSize: prepared.byteSize, includeVideo: prepared.includeVideo } };
}

/** Non-window Actions and Copy prepare their own full/current-frame output through the same pixel owner. */
export async function prepareRecordingDelivery(source: RecordingDeliverySource, options: RecordingPreparationOptions = {}):
    Promise<PreparedRecordingDelivery | ActionExecuteFailure> {
    options.signal?.throwIfAborted();
    const document = source.document ?? await loadNativeRecordingDocument(source.result.captureRef);
    const prepared = await prepareNativeRecordingDelivery({ ...source, document }, options);
    if ('ok' in prepared) return prepared;
    return readPreparedRecordingDelivery({ ...source, document, prepared }, options);
}

/** Optional content-bearing read uses the same player and current P2 document as delivery. */
export async function readRecordingDeliveryFrame(captureRef: string, sourceTimeMs: number, signal?: AbortSignal) {
    signal?.throwIfAborted();
    sourceTimeMs = toRecordingTimeMs(sourceTimeMs);
    const [result, document] = await Promise.all([readCaptureResult(captureRef), loadNativeRecordingDocument(captureRef)]);
    const selected = { sourceTimeMs, clipTimeMs: sourceTimeMs - document.trim.startMs,
        document: readRecordingFrameDocument(document, sourceTimeMs), notes: [] };
    const frames = await drawFrames({ result, document }, [selected], signal);
    if ('ok' in frames) return frames;
    const [frame] = frames;
    return { captureRef, sourceTimeMs, timeMs: selected.clipTimeMs, mimeType: 'image/png' as const,
        width: frame!.width, height: frame!.height, byteSize: frame!.bytes.length, dataBase64: encodeBase64(frame!.bytes) };
}
