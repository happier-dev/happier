import * as React from 'react';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { KeyboardShortcutProvider } from '@/keyboard/KeyboardShortcutProvider';
import { storage } from '@/sync/domains/state/storage';
import { createRecordingDocument } from './recordingDocument';
import { useRecordingEditor, type RecordingMediaAccess } from './useRecordingEditor';
import type { MediaPlayerVideoControls } from '@/components/workspaces/files/file/videoFrameAccess';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
let browser: JSDOM | undefined;
const initialSettings = storage.getState().settings;
afterEach(async () => { await standardCleanup(); storage.setState({ settings: initialSettings }); browser?.window.close(); browser = undefined; vi.unstubAllGlobals(); });

// Playback, decoder presentation and animation callbacks are browser boundaries.
function browserBoundary() {
    let notify: (playing: boolean) => void = () => {};
    let playing = false;
    let time = 0;
    const image = { uri: 'data:image/png;base64,AQID', width: 4, height: 4, timeSeconds: 0 };
    const read = vi.fn(async () => image);
    const controls: MediaPlayerVideoControls = {
        seekTo: value => { time = value; }, readFrame: read,
        playback: { play: () => { playing = true; notify(true); }, pause: () => { playing = false; notify(false); }, readTime: () => time,
            subscribe: listener => { notify = listener; return () => { notify = () => {}; }; } },
    };
    const media: RecordingMediaAccess = { renderPlayer: () => null, withFrames: operation => operation(controls) };
    return { controls, media, read, isPlaying: () => playing };
}

describe('recording editor transport', () => {
    it.each([[false, false], [true, false], [true, true]] as const)('prepares through its paused player, then restores time and playing=%s even on failure=%s', async (playing, fail) => {
        vi.stubGlobal('requestAnimationFrame', () => 1);
        vi.stubGlobal('cancelAnimationFrame', () => {});
        const boundary = browserBoundary();
        const document = createRecordingDocument({ frameDurationMs: 1000 / 25, sourceCaptureRef: 'movie', durationMs: 20_000, includeWindowText: false });
        const hook = await renderHook(() => useRecordingEditor({ document, commitDocument: async () => {}, media: boundary.media, scale: 1 }));
        await act(async () => { hook.getCurrent().setControls(boundary.controls); boundary.controls.seekTo(2); });
        if (playing) await act(async () => boundary.controls.playback!.play());
        const refusal = new Error('preparation_failed');
        let playingDuringPreparation: boolean | undefined;
        await act(async () => {
            const delivery = hook.getCurrent().prepareDelivery(async player => {
                playingDuringPreparation = boundary.isPlaying();
                player.seekTo(7);
                await player.readFrame({ timeSeconds: 7 });
                if (fail) throw refusal;
            });
            if (fail) await expect(delivery).rejects.toBe(refusal);
            else await expect(delivery).resolves.toMatchObject({ note: '' });
        });
        expect(playingDuringPreparation).toBe(false);
        expect(boundary.controls.playback!.readTime()).toBe(2);
        expect(hook.getCurrent().playing).toBe(playing);
    });

    it('uses editor transport for keyboard play/pause and reads the paused frame once', async () => {
        browser = new JSDOM('<body></body>', { url: 'http://capture.test' });
        vi.stubGlobal('window', browser.window);
        vi.stubGlobal('document', browser.window.document);
        vi.stubGlobal('requestAnimationFrame', () => 1);
        vi.stubGlobal('cancelAnimationFrame', () => {});
        storage.setState({ settings: { ...initialSettings, keyboardShortcutsV2Enabled: true, keyboardSingleKeyShortcutsEnabled: true } });
        const boundary = browserBoundary();
        const documentState = createRecordingDocument({ frameDurationMs: 1000 / 25, sourceCaptureRef: 'movie', durationMs: 20_000, includeWindowText: false });
        let editor: ReturnType<typeof useRecordingEditor> | undefined;
        function Editor() {
            editor = useRecordingEditor({ document: documentState, commitDocument: async () => {}, media: boundary.media, scale: 1 });
            return null;
        }
        await renderScreen(<KeyboardShortcutProvider handlers={{}} enabledWhenDisabledCommandIds={['media.playPause']}><Editor /></KeyboardShortcutProvider>);
        await act(async () => editor!.setControls(boundary.controls));
        const space = () => document.dispatchEvent(new browser!.window.KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true, cancelable: true }));
        await act(async () => { space(); });
        expect(editor!.playing).toBe(true);
        boundary.read.mockClear();
        await act(async () => { space(); });
        expect(editor!.playing).toBe(false);
        expect(boundary.read).toHaveBeenCalledTimes(1);
    });

    it.each([[true, 2_000, true], [false, 2_000, false], [true, 20_000, false]] as const)('preserves playing=%s at seek %s (result %s), one read and none after hide', async (playing, target, expectedPlaying) => {
        const paints = new Map<number, FrameRequestCallback>();
        let next = 0;
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { paints.set(++next, callback); return next; });
        vi.stubGlobal('cancelAnimationFrame', (id: number) => { paints.delete(id); });
        const boundary = browserBoundary();
        const document = createRecordingDocument({ frameDurationMs: 1000 / 25, sourceCaptureRef: 'movie', durationMs: 20_000, includeWindowText: false });
        const hook = await renderHook(() => useRecordingEditor({ document, commitDocument: async () => {}, media: boundary.media, scale: 1 }));
        await act(async () => hook.getCurrent().setControls(boundary.controls));
        if (playing) await act(async () => boundary.controls.playback!.play());
        boundary.read.mockClear();
        await act(async () => { hook.getCurrent().scrub(1_000); hook.getCurrent().scrub(target); });
        await act(async () => hook.getCurrent().settle(target));
        expect(hook.getCurrent().playing).toBe(expectedPlaying);
        expect(boundary.read).toHaveBeenCalledTimes(1);
        await hook.unmount();
        expect(paints.size).toBe(0);
        expect(boundary.read).toHaveBeenCalledTimes(1);
    });

    it('exposes a failed first decode and an explicit retry without losing the edit document', async () => {
        const boundary = browserBoundary();
        boundary.read.mockRejectedValueOnce(new Error('decode_failed'));
        const document = createRecordingDocument({ frameDurationMs: 1000 / 25, sourceCaptureRef: 'movie', durationMs: 20_000, includeWindowText: false });
        const hook = await renderHook(() => useRecordingEditor({ document, commitDocument: async () => {}, media: boundary.media, scale: 1 }));
        expect(hook.getCurrent().status).toBe('failed');
        expect(boundary.read).toHaveBeenCalledTimes(1);
        await act(async () => { await hook.getCurrent().retry(); });
        expect(hook.getCurrent().status).toBe('ready');
        expect(hook.getCurrent().effective).toBe(document);
        expect(boundary.read).toHaveBeenCalledTimes(2);
    });
});
