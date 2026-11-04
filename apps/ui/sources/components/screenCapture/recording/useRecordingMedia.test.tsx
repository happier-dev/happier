// @vitest-environment jsdom
import * as React from 'react';
import { readFile, mkdtemp, rename, rm, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyImageMarksOperations, ImageMarksDocumentV1Schema } from '@happier-dev/protocol';
import { act, renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import type { NativeCaptureResult } from '@/desktop/capture/nativeCapture';
import { useRecordingMedia } from './useRecordingMedia';
import { useRecordingEditor } from './useRecordingEditor';
import { createRecordingDocument, reduceRecordingDocument } from './recordingDocument';

const boundary = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('@/desktop/capture/nativeCapture', () => ({ readCaptureSource: boundary.read }));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
// Expo's player/view are the native playback boundary. Hooks, HeldVideoPlayer and frame access stay real.
vi.mock('expo-video', async () => {
    const React = await import('react');
    return {
        useVideoPlayer: (uri: string) => React.useMemo(() => ({ status: 'readyToPlay', uri,
            play() {}, pause() {}, addListener: () => ({ remove() {} }), currentTime: 0,
        }), [uri]),
        VideoView: React.forwardRef((props: Record<string, unknown>, ref) => {
            const video = React.useMemo(() => document.createElement('video'), []);
            React.useImperativeHandle(ref, () => ({ nativeRef: { current: video } }));
            return React.createElement('VideoView', props);
        }),
    };
});
beforeEach(() => {
    vi.stubGlobal('URL', class extends URL {
        static createObjectURL = vi.fn<typeof URL.createObjectURL>();
        static revokeObjectURL = vi.fn();
    });
});
afterEach(async () => { await standardCleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('recording media source', () => {
    it.each([
        { position: 'beyond EOF', startMs: 4071, hidden: false },
        { position: 'held final sample', startMs: 2990, hidden: false },
        { position: 'hidden held final sample', startMs: 2990, hidden: true },
    ])('restores a playable editor at $position after source rename/restore/Retry with every edit retained', async ({ startMs, hidden }) => {
        let visibility: DocumentVisibilityState = hidden ? 'hidden' : 'visible';
        vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
        const folder = await mkdtemp(join(tmpdir(), 'recording-recovery-'));
        const path = join(folder, 'movie.mp4');
        await copyFile(join(process.cwd(), 'sources/dev/testkit/fixtures/media/recording-rgb-3s.mp4'), path);
        await rename(path, `${path}.held`);
        boundary.read.mockReset().mockImplementation(() => readFile(path));
        const blobs: Blob[] = [];
        vi.spyOn(URL, 'createObjectURL').mockImplementation(blob => {
            if (!(blob instanceof Blob)) throw new TypeError('Expected movie bytes');
            blobs.push(blob);
            return `blob:movie-${blobs.length}`;
        });
        vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
        const createElement = document.createElement.bind(document);
        // Browser decoder boundary: a retained timestamp is clamped to this real vector's 3s end.
        // The adjacent browser gate decodes the same bytes and inspects its final blue pixels.
        vi.spyOn<{ createElement(tagName: string, options?: ElementCreationOptions): HTMLElement }, 'createElement'>(document, 'createElement').mockImplementation((tag, options) => {
            const element = createElement(tag, options);
            if (tag !== 'video') return element;
            const video = element as HTMLVideoElement;
            let time = 0;
            Object.defineProperties(video, {
                readyState: { value: 4 }, duration: { value: 3 }, videoWidth: { value: 64 }, videoHeight: { value: 48 },
                currentTime: { get: () => time, set: (value: number) => {
                    time = Math.min(3, value);
                    queueMicrotask(() => video.dispatchEvent(new Event('seeked')));
                } },
            });
            Object.assign(video, {
                pause() {}, load() {}, play: async () => {
                    time = 3;
                    queueMicrotask(() => video.dispatchEvent(new Event('ended')));
                },
                // No new frame is presented while parked at EOF.
                requestVideoFrameCallback: () => 1, cancelVideoFrameCallback() {},
            });
            return video;
        });
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { queueMicrotask(() => callback(0)); return 1; });
        vi.stubGlobal('cancelAnimationFrame', () => {});
        vi.spyOn<{ getContext(contextId: '2d'): CanvasRenderingContext2D | null }, 'getContext'>(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage() {} } as unknown as CanvasRenderingContext2D);
        vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,AQID');
        const marked = applyImageMarksOperations(ImageMarksDocumentV1Schema.parse({
            v: 1, image: { width: 64, height: 48, scale: 1 }, marks: [],
        }), [{ kind: 'mark.add', mark: { id: 'secret', kind: 'blur', rect: { x: 0, y: 0, width: 10, height: 10 }, size: 'm' } }]);
        let documentState = createRecordingDocument({ frameDurationMs: 1000 / 25, sourceCaptureRef: 'movie', durationMs: 4271, includeWindowText: false });
        for (const operation of [
            { kind: 'trim.set', startMs, endMs: 4271 },
            { kind: 'defaultPin.move', sourceTimeMs: 100 },
            { kind: 'pin.add', sourceTimeMs: 4100 },
            { kind: 'note.set', id: 'note', sourceTimeMs: 4100, text: 'Keep this edit' },
            { kind: 'frame.document', sourceTimeMs: 4100, document: marked, cause: 'edit' },
            { kind: 'includeVideo.set', mode: 'off' },
        ] as const) documentState = reduceRecordingDocument(documentState, operation);
        const capture = { captureRef: 'movie', mimeType: 'video/mp4' } as NativeCaptureResult;
        const commit = vi.fn(async () => {});
        let source: ReturnType<typeof useRecordingMedia> | undefined;
        let editor: ReturnType<typeof useRecordingEditor> | undefined;
        function Loaded({ media }: { media: NonNullable<ReturnType<typeof useRecordingMedia>['media']> }) {
            editor = useRecordingEditor({ document: documentState, commitDocument: commit, media, scale: 1 });
            return editor.frameSource ? media.renderPlayer(editor.setControls) : null;
        }
        function Capture() {
            source = useRecordingMedia(capture, null);
            return source.media ? <Loaded media={source.media} /> : null;
        }
        try {
            await renderScreen(<Capture />);
            await act(async () => { await boundary.read.mock.results[0]!.value.catch(() => {}); });
            expect(source!.status).toBe('failed');
            await rename(`${path}.held`, path);
            await act(async () => { source!.retry(); });
            await act(async () => { await boundary.read.mock.results[1]!.value; });
            expect(source!.status, 'restored native bytes have become a fresh movie Blob').toBe('ready');
            expect(blobs[0]!.size).toBe((await readFile(path)).length);
            if (hidden) {
                expect(editor!.status).toBe('loading');
                await act(async () => {
                    visibility = 'visible';
                    document.dispatchEvent(new Event('visibilitychange'));
                });
            }
            expect(editor!.status, 'the restored movie must finish decoding before its player can mount').toBe('ready');
            expect(editor!.controlsReady).toBe(true);
            expect(editor!.effective).toEqual(documentState);
            expect(commit).not.toHaveBeenCalled();
            expect(boundary.read).toHaveBeenCalledTimes(2);
        } finally { await rm(folder, { recursive: true, force: true }); }
    });

    it('reports a failed source read and retries only on request', async () => {
        boundary.read.mockRejectedValueOnce(new Error('source_unavailable')).mockResolvedValueOnce([1, 2, 3]);
        vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:movie');
        vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
        const capture = { captureRef: 'movie', mimeType: 'video/mp4' } as NativeCaptureResult;
        const hook = await renderHook(() => useRecordingMedia(capture, null));
        expect(hook.getCurrent()?.status).toBe('failed');
        expect(boundary.read).toHaveBeenCalledTimes(1);
        await act(async () => { hook.getCurrent()?.retry(); });
        expect(hook.getCurrent()?.status).toBe('ready');
        expect(boundary.read).toHaveBeenCalledTimes(2);
        expect(hook.getCurrent()?.media).not.toBeNull();
    });
});
