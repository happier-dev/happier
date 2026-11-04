// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Blob as NodeBlob } from 'node:buffer';
import { installImageAnnotationCanvasBoundary } from '@/dev/testkit/mocks/imageAnnotationCanvas';
import { createRecordingDocument, reduceRecordingDocument, type RecordingDocument } from '@/components/screenCapture/recording/recordingDocument';
import { copyCaptureFromUi } from '@/components/screenCapture/window/copyCaptureFromUi';
import type { NativeCaptureResult, NativePreparedRecording } from '@/desktop/capture/nativeCapture';
import { prepareNativeRecordingDelivery, prepareRecordingDelivery, readPreparedRecordingDelivery } from './prepareRecordingDelivery';
import { readVideoFrame } from '@/components/workspaces/files/file/videoFrameAccess';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import { dispatchDesktopCaptureWindowAction } from '@/utils/platform/desktopWindowActionDispatch';
import { createNativeScreenCaptureAction, prepareCaptureDelivery, readNativeCaptureDelivery, resolveCaptureDelivery } from './screenCaptureActions';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const result: NativeCaptureResult = { captureRef: 'source', kind: 'video', path: '/Library/source.mp4', mimeType: 'video/mp4',
    byteSize: 100, pixelSize: { width: 4, height: 4 }, scale: 1, origin: null, source: null, windowTextRef: null };

function nativeAndDecoder(recordingDocument?: RecordingDocument) {
    // jsdom's Blob lacks arrayBuffer; use the platform encoder's real Blob contract.
    vi.stubGlobal('Blob', NodeBlob);
    const commands: Array<{ command: string; args?: Record<string, unknown> }> = [];
    let frameCount = 0;
    let preparedRecording: NativePreparedRecording | null = null;
    const emitted: unknown[] = [];
    const create = document.createElement.bind(document);
    const videos: HTMLVideoElement[] = [];
    vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
        const element = create(tag);
        if (tag === 'video') {
            const video = element as HTMLVideoElement;
            let currentTime = 0;
            Object.defineProperties(video, { readyState: { value: 2 }, paused: { value: true }, seeking: { value: false },
                videoWidth: { value: 4 }, videoHeight: { value: 4 }, currentTime: { get: () => currentTime, set: (value: number) => {
                    currentTime = value;
                    queueMicrotask(() => video.dispatchEvent(new Event('seeked')));
                } } });
            vi.spyOn(video, 'load').mockImplementation(() => {});
            vi.spyOn(video, 'pause').mockImplementation(() => {});
            vi.spyOn(video, 'play').mockImplementation(async () => {});
            videos.push(video);
        }
        return element;
    }) as typeof document.createElement);
    // Match the decoder owner's seek-complete and presented-paint boundary, not merely readyState.
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { queueMicrotask(() => callback(0)); return 1; });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    // Browser decoder/canvas boundary; all selection, disclosure and P2 burn-in logic stays real.
    // DOM/WebGPU add overloads; this browser boundary deliberately supports only the used 2D context.
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(((kind: string) => kind === '2d'
        ? { drawImage: () => { frameCount++; } } : null) as unknown as HTMLCanvasElement['getContext']);
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,AQID');
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:source') });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
    vi.stubGlobal('__TAURI_INTERNALS__', { invoke: async (command: string, args?: Record<string, unknown>) => {
        commands.push({ command, args });
        if (command === 'desktop_capture_read_result') return args?.captureRef === 'trimmed'
            ? { ...result, captureRef: 'trimmed', path: '/Library/trimmed.mp4', byteSize: 50 } : result;
        if (command === 'desktop_window_emit_action_result') { emitted.push(args!.payload); return; }
        if (command === 'desktop_capture_read_delivery_state') return { inUse: true, disclosure: { hasMarks: false, includeWindowText: false }, windowText: null, preparedRecording };
        if (command === 'desktop_recording_document_read') return recordingDocument;
        if (command === 'desktop_capture_read_source_png') return [20, 21];
        if (command === 'desktop_recording_trim') return { ...result, captureRef: 'trimmed', path: '/Library/trimmed.mp4', byteSize: 50 };
        if (command === 'desktop_recording_prepare') {
            const frames = args!.frames as Array<{ timeMs: number; note: string | null; bytes: number[] }>;
            preparedRecording = { captureRef: 'source', frames: frames.map((frame, index) => ({ frameRef: `frame-${index}`, timeMs: frame.timeMs,
                note: frame.note, pixelSize: result.pixelSize, byteSize: frame.bytes.length })),
                videoRef: typeof args!.videoRef === 'string' ? args!.videoRef : null, includeVideo: args!.includeVideo === true,
                byteSize: frames.reduce((sum, frame) => sum + frame.bytes.length, 0) + (args!.includeVideo ? 50 : 0) };
            return preparedRecording;
        }
        if (command === 'desktop_capture_read_prepared_png') return args!.captureRef === 'frame-1' ? [9, 8, 7] : [1, 2, 3];
        throw new Error(`Unexpected native command ${command}`);
    } });
    return { commands, videos, emitted, frameCount: () => frameCount, prepared: () => preparedRecording };
}

describe('recording outgoing preparation', () => {
    it.each(['screenCapture.addToDraft', 'screenCapture.send'] as const)('%s settles prepared Capture-window intake while main stays hidden, without a main decoder', async actionIdentifier => {
        const recordingDocument = createRecordingDocument({ frameDurationMs: 40, sourceCaptureRef: 'source', durationMs: 5000, includeWindowText: false });
        const boundary = nativeAndDecoder(recordingDocument);
        // The visible window already owns its movie player; use its real frame accessor.
        const player = document.createElement('video');
        const lifetime = new AbortController();
        const prepared = await prepareNativeRecordingDelivery({ result }, { controls: {
            seekTo: time => { player.currentTime = time; },
            readFrame: (options = {}) => readVideoFrame(player, options, lifetime.signal),
        } });
        expect(prepared).not.toHaveProperty('ok');
        expect(boundary.commands.some(call => call.command === 'desktop_capture_read_source_png')).toBe(false);
        const before = boundary.commands.length;
        const heldPlayers = boundary.videos.length;
        vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({
            screenCaptureAction: createNativeScreenCaptureAction({ captureWindowPress: true }),
        }));
        const pending = dispatchDesktopCaptureWindowAction({ windowLabel: 'capture_2', requestId: 'hidden-delivery', actionIdentifier,
            data: { captureRef: 'source', session: { serverId: 'server', accountId: 'account', sessionId: 'session' } } }, executor);
        try {
            // Session intake may refuse the unavailable fixture Account, but preparation must settle
            // without asking the hidden main document to present video pixels.
            await vi.waitFor(() => expect({
                settled: boundary.emitted.some(event => typeof event === 'object' && event !== null && 'phase' in event && event.phase === 'settled'),
                decodersInMain: boundary.videos.length - heldPlayers,
                visibility: document.visibilityState,
            }).toEqual({ settled: true, decodersInMain: 0, visibility: 'hidden' }));
            expect(boundary.videos).toHaveLength(heldPlayers);
            expect(boundary.commands.slice(before).filter(call => call.command === 'desktop_capture_read_source_png')).toHaveLength(1);
            expect(boundary.commands.slice(before).some(call => call.command === 'desktop_recording_prepare')).toBe(false);
        } finally {
            vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
            document.dispatchEvent(new Event('visibilitychange'));
            await pending;
            lifetime.abort();
        }
    });

    it('refuses missing native preparation for a Capture press without creating a hidden decoder', async () => {
        const boundary = nativeAndDecoder();
        vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
        const record = await readNativeCaptureDelivery('source');
        if ('ok' in record) throw new Error(record.errorCode);
        const delivery = resolveCaptureDelivery(record, { surface: 'ui' }, { captureWindowPress: true });
        if ('ok' in delivery) throw new Error(delivery.errorCode);
        expect(await prepareCaptureDelivery(delivery, { captureWindowPress: true }))
            .toMatchObject({ ok: false, errorCode: 'capture_not_prepared' });
        expect(boundary.videos).toEqual([]);
        expect(boundary.commands.map(call => call.command).sort()).toEqual(['desktop_capture_read_delivery_state', 'desktop_capture_read_result']);
    });

    it('keeps ordinary Actions and Copy on current-document preparation after a partial Copy output exists', async () => {
        const document = reduceRecordingDocument(createRecordingDocument({ frameDurationMs: 40, sourceCaptureRef: 'source',
            durationMs: 5000, includeWindowText: false }), { kind: 'pin.add', sourceTimeMs: 2000 });
        const boundary = nativeAndDecoder(document);
        await prepareRecordingDelivery({ result, document }, { imageOnly: true, frameAtMs: 2000 });
        const partial = boundary.prepared()!;
        expect(partial.includeVideo).toBe(false);
        const delivered = await prepareCaptureDelivery({ recording: { result, document, prepared: partial } });
        if ('ok' in delivered) throw new Error(delivered.errorCode);
        expect(delivered.items.map(item => item.kind)).toEqual(['image', 'video']);
        expect(delivered.summary?.includeVideo).toBe(true);
        const copied = await prepareRecordingDelivery({ result, document, prepared: partial }, { imageOnly: true, frameAtMs: 1000 });
        if ('ok' in copied) throw new Error(copied.errorCode);
        expect(copied.video).toBeUndefined();
        expect(boundary.prepared()?.frames.map(frame => frame.timeMs)).toEqual([1000]);
    });

    it('cancels prepared intake before any native content read', async () => {
        const boundary = nativeAndDecoder();
        const abort = new AbortController(); abort.abort();
        await expect(readPreparedRecordingDelivery({ result, prepared: null }, { signal: abort.signal }))
            .rejects.toMatchObject({ name: 'AbortError' });
        expect(boundary.commands).toEqual([]);
        expect(boundary.videos).toEqual([]);
    });
    it('copies the viewed marked frame through the UI Action and native prepared reference, not the first selected frame', async () => {
        const document = reduceRecordingDocument(reduceRecordingDocument(createRecordingDocument({ frameDurationMs: 1000 / 25,
            sourceCaptureRef: 'source', durationMs: 5000, includeWindowText: false,
        }), { kind: 'trim.set', startMs: 1000, endMs: 3000 }), {
            kind: 'frame.document', sourceTimeMs: 2000, cause: 'edit', document: { v: 1,
                image: { width: 4, height: 4, scale: 1 }, marks: [{ id: 'blur', kind: 'blur', rect: { x: 0, y: 0, width: 4, height: 4 }, size: 's' }] },
        });
        const boundary = nativeAndDecoder(document);
        const pixels = new Uint8ClampedArray(64);
        for (let pixel = 0; pixel < 16; pixel++) pixels.set([pixel % 2 ? 255 : 0, pixel % 2 ? 255 : 0, pixel % 2 ? 255 : 0, 255], pixel * 4);
        const canvas = installImageAnnotationCanvasBoundary({ width: 4, height: 4, pixels });
        const written: Uint8Array[] = [];
        vi.stubGlobal('ClipboardItem', class { constructor(readonly data: Readonly<Record<string, Promise<Blob>>>) {} });
        const write = vi.fn(async (items: Array<{ data: Readonly<Record<string, Promise<Blob>>> }>) => {
            written.push(new Uint8Array(await (await items[0]!.data['image/png'])!.arrayBuffer()));
        });
        vi.stubGlobal('navigator', { clipboard: { write } });
        const pending = copyCaptureFromUi({ captureRef: 'source', frameAtMs: 2000 });
        expect(write).toHaveBeenCalledOnce();
        expect(await pending).toMatchObject({ ok: true, result: { captureRef: 'source', status: 'copied' } });
        expect(canvas.encodeCount()).toBe(1);
        expect([...canvas.outputs[0]!.slice(0, 4)]).toEqual([128, 128, 128, 255]);
        expect(boundary.commands.find(call => call.command === 'desktop_recording_prepare')?.args).toMatchObject({
            frames: [{ timeMs: 1000, bytes: [9, 8, 7] }], includeVideo: false, hasMarks: true, includeWindowText: false,
        });
        expect(written).toEqual([new Uint8Array([1, 2, 3])]);
        expect(boundary.commands.filter(call => call.command === 'desktop_capture_read_prepared_png')).toHaveLength(1);
        expect(boundary.commands.some(call => call.command === 'desktop_recording_trim' || call.command === 'desktop_capture_window_text')).toBe(false);
    });

    it('draws distinct selected times only, burns each included marked frame once and excludes the movie after blur', async () => {
        const boundary = nativeAndDecoder();
        const pixels = new Uint8ClampedArray(64);
        for (let pixel = 0; pixel < 16; pixel++) pixels.set([pixel % 2 ? 255 : 0, pixel % 2 ? 255 : 0, pixel % 2 ? 255 : 0, 255], pixel * 4);
        const canvas = installImageAnnotationCanvasBoundary({ width: 4, height: 4, pixels });
        let document = createRecordingDocument({ frameDurationMs: 1000 / 25, sourceCaptureRef: 'source', durationMs: 5000, includeWindowText: true });
        for (const operation of [
            { kind: 'pin.add', sourceTimeMs: 1000 }, { kind: 'pin.add', sourceTimeMs: 2000 },
            { kind: 'note.set', id: 'words', sourceTimeMs: 2000, text: 'Visible words' },
            { kind: 'note.set', id: 'more-words', sourceTimeMs: 2000, text: 'Watch the transition' },
            { kind: 'note.set', id: 'excluded', sourceTimeMs: 4000, text: 'Excluded words' },
            { kind: 'trim.set', startMs: 1000, endMs: 3000 },
        ] as const) document = reduceRecordingDocument(document, operation);
        document = reduceRecordingDocument(document, { kind: 'frame.document', sourceTimeMs: 2000, cause: 'edit', document: {
            v: 1, image: { width: 4, height: 4, scale: 1 }, marks: [{ id: 'secret', kind: 'blur', rect: { x: 0, y: 0, width: 4, height: 4 }, size: 's' }],
        } });
        const prepared = await prepareRecordingDelivery({ result, document });
        if ('ok' in prepared) throw new Error(prepared.errorCode);
        expect(boundary.frameCount()).toBe(2);
        expect(canvas.encodeCount()).toBe(1);
        expect([...canvas.outputs[0]!.slice(0, 4)]).toEqual([128, 128, 128, 255]);
        expect(prepared.images.map(image => [...image.bytes])).toEqual([[1, 2, 3], [9, 8, 7]]);
        expect(prepared.images.map(image => image.note)).toEqual([
            '0:00.000 — pin',
            '0:01.000 — pin; note: "Visible words"; note: "Watch the transition"; marked frame: blur',
        ]);
        expect(prepared.video).toBeUndefined();
        expect(prepared.summary).toEqual({ frameCount: 2, durationMs: 2000, byteSize: 6, includeVideo: false });
        expect(boundary.commands.filter(call => call.command === 'desktop_recording_prepare')).toHaveLength(1);
        expect(boundary.commands.some(call => call.command === 'desktop_recording_trim')).toBe(false);
        expect(boundary.videos).toHaveLength(1);
        expect(boundary.videos[0]!.hasAttribute('src')).toBe(false);
        expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:source');
    });

    it('physically trims an included movie, reads bytes by reference and does no movie work for Copy', async () => {
        const boundary = nativeAndDecoder();
        const document = reduceRecordingDocument(createRecordingDocument({ frameDurationMs: 1000 / 25, sourceCaptureRef: 'source', durationMs: 5000, includeWindowText: false }),
            { kind: 'trim.set', startMs: 1000, endMs: 3000 });
        const prepared = await prepareRecordingDelivery({ result, document });
        if ('ok' in prepared) throw new Error(prepared.errorCode);
        expect(prepared.video).toMatchObject({ bytes: new Uint8Array([20, 21]), mimeType: 'video/mp4' });
        expect(prepared.images[0]!.note).toBe('0:00.000 — pin');
        expect(boundary.commands.filter(call => call.command === 'desktop_recording_trim')).toEqual([
            { command: 'desktop_recording_trim', args: { captureRef: 'source', startMs: 1000, endMs: 3000 } },
        ]);
        const before = boundary.commands.length;
        await prepareRecordingDelivery({ result, document }, { imageOnly: true });
        expect(boundary.commands.slice(before).some(call => call.command === 'desktop_recording_trim')).toBe(false);
        expect(boundary.commands.slice(before).filter(call => call.command === 'desktop_capture_read_source_png')).toHaveLength(1);
    });

    it('a cancelled request starts neither decoding nor native export', async () => {
        const boundary = nativeAndDecoder();
        const abort = new AbortController(); abort.abort();
        await expect(prepareRecordingDelivery({ result, document: createRecordingDocument({ frameDurationMs: 1000 / 25, sourceCaptureRef: 'source', durationMs: 5000, includeWindowText: false }) },
            { signal: abort.signal })).rejects.toMatchObject({ name: 'AbortError' });
        expect(boundary.commands).toEqual([]);
        expect(boundary.videos).toEqual([]);
    });

    it('a current marked frame that cannot flatten refuses delivery without exporting or substituting source pixels', async () => {
        const boundary = nativeAndDecoder();
        installImageAnnotationCanvasBoundary({ width: 4, height: 4, pixels: new Uint8ClampedArray(64), canvasUnavailable: true });
        const document = reduceRecordingDocument(createRecordingDocument({ frameDurationMs: 1000 / 25, sourceCaptureRef: 'source', durationMs: 5000, includeWindowText: false }),
            { kind: 'frame.document', sourceTimeMs: 1000, cause: 'edit', document: { v: 1,
                image: { width: 4, height: 4, scale: 1 }, marks: [{ id: 'arrow', kind: 'arrow',
                    from: { x: 0, y: 0 }, to: { x: 3, y: 3 }, color: 'red', size: 's' }] } });
        expect(await prepareRecordingDelivery({ result, document })).toEqual({ ok: false, errorCode: 'canvasUnavailable', error: 'canvasUnavailable' });
        expect(boundary.commands.map(call => call.command)).toEqual(['desktop_capture_read_source_png']);
        expect(document.frames[0]!.document.marks).toHaveLength(1);
        expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:source');
    });
});
