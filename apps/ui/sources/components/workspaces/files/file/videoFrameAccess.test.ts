// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { readVideoFrame, withVideoFrameSource } from './videoFrameAccess';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function videoFixture(initialReadyState = 2) {
    const video = document.createElement('video');
    let time = 1;
    let seeking = false;
    let readyState = initialReadyState;
    let paused = true;
    Object.defineProperties(video, {
        videoWidth: { value: 640 }, videoHeight: { value: 360 }, readyState: { get: () => readyState },
        paused: { get: () => paused, configurable: true }, seeking: { get: () => seeking },
        currentTime: { get: () => time, set: (value: number) => { time = value; seeking = true; } },
    });
    vi.spyOn(video, 'pause').mockImplementation(() => { paused = true; });
    vi.spyOn(video, 'play').mockImplementation(async () => { paused = false; video.dispatchEvent(new Event('playing')); });
    vi.spyOn(video, 'load').mockImplementation(() => {});
    // Browser paint delivery is a system boundary, not an elapsed-time wait.
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { queueMicrotask(() => callback(0)); return 1; });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const drawImage = vi.fn();
    // Canvas encoding and the decoder's frame/seek events are browser system boundaries.
    vi.spyOn<{ getContext(contextId: '2d'): CanvasRenderingContext2D | null }, 'getContext'>(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,cGl4ZWxz');
    return {
        video, drawImage,
        finishLoad: () => { readyState = 2; video.dispatchEvent(new Event('loadeddata')); },
        decodeWithoutSeeked: () => { seeking = false; video.dispatchEvent(new Event('loadeddata')); },
        finishSeek: () => { seeking = false; video.dispatchEvent(new Event('seeked')); },
    };
}

function presentedFixture() {
    const fixture = videoFixture(4);
    const paints = new Map<number, FrameRequestCallback>();
    let nextPaint = 0;
    let presentedPixels = 'transparent';
    let drawnPixels = '';
    const request = vi.fn((callback: FrameRequestCallback) => { paints.set(++nextPaint, callback); return nextPaint; });
    const cancel = vi.fn((id: number) => { paints.delete(id); });
    vi.stubGlobal('requestAnimationFrame', request);
    vi.stubGlobal('cancelAnimationFrame', cancel);
    // Availability of rVFC does not imply that a held track will deliver another callback.
    Object.assign(fixture.video, { requestVideoFrameCallback: vi.fn(() => 1), cancelVideoFrameCallback: vi.fn() });
    fixture.drawImage.mockImplementation(() => { drawnPixels = presentedPixels; });
    vi.mocked(HTMLCanvasElement.prototype.toDataURL).mockImplementation(() => `data:image/png;base64,${drawnPixels}`);
    return {
        ...fixture, request, cancel, paints,
        present: () => {
            presentedPixels = 'red-frame';
            for (const [id, callback] of [...paints]) {
                paints.delete(id);
                callback(0);
            }
        },
    };
}

function headlessFixture() {
    const fixture = videoFixture(0);
    // WebKit emits emptied when load() resets the source-selection operation.
    vi.mocked(fixture.video.load).mockImplementation(() => fixture.video.dispatchEvent(new Event('emptied')));
    const createElement = document.createElement.bind(document);
    const create = vi.spyOn<{ createElement(tagName: string, options?: ElementCreationOptions): HTMLElement }, 'createElement'>(document, 'createElement').mockImplementation((tagName, options) => (
        tagName === 'video' ? fixture.video : createElement(tagName, options)
    ));
    return { ...fixture, create };
}

describe('player frame access', () => {
    it('reads a held final sample without depending on another frame callback or ended', async () => {
        const fixture = presentedFixture();
        Object.defineProperty(fixture.video, 'duration', { value: 5 });
        const pending = readVideoFrame(fixture.video, { timeSeconds: 4.99 }, new AbortController().signal);
        fixture.finishSeek();
        await Promise.resolve();
        // The movie timeline can outlast the encoded track: neither event is required.
        fixture.present();
        expect(await pending).toMatchObject({ timeSeconds: 4.99, durationSeconds: 5 });
        expect(fixture.drawImage).toHaveBeenCalledTimes(1);
        expect(fixture.paints.size).toBe(0);
    });

    it('defers presentation while the page is hidden and resumes on visibility rather than painting transparent pixels', async () => {
        const fixture = presentedFixture();
        let visibility: DocumentVisibilityState = 'hidden';
        vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
        const pending = readVideoFrame(fixture.video, {}, new AbortController().signal);
        await Promise.resolve();
        expect(fixture.video.play).not.toHaveBeenCalled();
        expect(fixture.request).not.toHaveBeenCalled();
        visibility = 'visible';
        document.dispatchEvent(new Event('visibilitychange'));
        await Promise.resolve();
        await Promise.resolve();
        fixture.present();
        expect(await pending).toMatchObject({ uri: 'data:image/png;base64,red-frame' });
    });

    it('reads the decoded end frame without restarting playback and waiting for another frame', async () => {
        const fixture = presentedFixture();
        Object.defineProperty(fixture.video, 'duration', { value: 3 });
        const pending = readVideoFrame(fixture.video, { timeSeconds: 4.071 }, new AbortController().signal);
        fixture.video.currentTime = 3; // The decoder clamps a retained trim timestamp to the actual media end.
        fixture.finishSeek();
        await Promise.resolve();
        expect(fixture.video.play).not.toHaveBeenCalled();
        fixture.present();
        expect(await pending).toMatchObject({ timeSeconds: 3, durationSeconds: 3 });
        expect(fixture.drawImage).toHaveBeenCalledTimes(1);
    });

    it('restores paused host intent when a cancelled priming play completes late', async () => {
        const fixture = presentedFixture();
        let start: () => void = () => {};
        vi.mocked(fixture.video.play).mockImplementation(() => new Promise<void>(resolve => {
            start = () => {
                Object.defineProperty(fixture.video, 'paused', { get: () => false, configurable: true });
                resolve();
            };
        }));
        // Browser playback can finish asynchronously after a request has been cancelled.
        // The host's intent is still paused, independently of that transient decoder state.
        const restore = vi.fn(() => fixture.video.pause());
        vi.mocked(fixture.video.pause).mockImplementation(() => {
            Object.defineProperty(fixture.video, 'paused', { get: () => true, configurable: true });
        });
        const caller = new AbortController();
        const pending = readVideoFrame(fixture.video, { signal: caller.signal }, new AbortController().signal, restore);
        const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
        caller.abort();
        await rejected;
        start();
        await Promise.resolve();
        await Promise.resolve();
        expect(fixture.video.paused).toBe(true);
        expect(fixture.paints.size).toBe(0);
    });

    it('restores host intent instead of promoting transient priming playback into user intent', async () => {
        const fixture = presentedFixture();
        await fixture.video.play();
        const pending = readVideoFrame(fixture.video, {}, new AbortController().signal, () => fixture.video.pause());
        await Promise.resolve();
        fixture.present();
        await pending;
        expect(fixture.video.paused).toBe(true);
    });

    it('does not mistake readyState 4 for presented pixels on a paused same-time read, and restores the player after one muted presentation', async () => {
        const fixture = presentedFixture();
        const play = vi.mocked(fixture.video.play);
        play.mockImplementation(async () => { expect(fixture.video.muted).toBe(true); });
        const result = readVideoFrame(fixture.video, {}, new AbortController().signal);
        await Promise.resolve();
        expect(fixture.drawImage).not.toHaveBeenCalled();
        expect(fixture.request).toHaveBeenCalledTimes(1);
        expect(play).toHaveBeenCalledTimes(1);
        fixture.present();
        expect(await result).toMatchObject({ uri: 'data:image/png;base64,red-frame', timeSeconds: 1 });
        expect(fixture.video.paused).toBe(true);
        expect(fixture.video.muted).toBe(false);
        expect(fixture.video.currentTime).toBe(1);
        expect(fixture.paints.size).toBe(0);
        expect(play).toHaveBeenCalledTimes(1);
    });

    it('waits for seeked and one animation frame when presented-frame callbacks are unavailable', async () => {
        const fixture = videoFixture(4);
        let paint: FrameRequestCallback | undefined;
        const request = vi.fn((callback: FrameRequestCallback) => { paint = callback; return 1; });
        vi.stubGlobal('requestAnimationFrame', request);
        const pending = readVideoFrame(fixture.video, { timeSeconds: 2 }, new AbortController().signal);
        expect(request).not.toHaveBeenCalled();
        fixture.decodeWithoutSeeked();
        expect(request).not.toHaveBeenCalled();
        fixture.finishSeek();
        await Promise.resolve();
        expect(fixture.drawImage).not.toHaveBeenCalled();
        expect(request).toHaveBeenCalledTimes(1);
        paint?.(0);
        expect(await pending).toMatchObject({ timeSeconds: 2 });
        expect(fixture.video.play).toHaveBeenCalledTimes(1);
    });

    it('waits for a paint only after playback has started, and cancels safely while play is pending', async () => {
        const fixture = presentedFixture();
        let playing: () => void = () => {};
        const started = new Promise<void>(resolve => { playing = resolve; });
        vi.mocked(fixture.video.play).mockReturnValue(started);
        const caller = new AbortController();
        const pending = readVideoFrame(fixture.video, { signal: caller.signal }, new AbortController().signal);
        const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
        await Promise.resolve();
        expect(fixture.request).not.toHaveBeenCalled();
        caller.abort();
        await rejected;
        playing();
        await Promise.resolve();
        expect(fixture.request).not.toHaveBeenCalled();
        expect(fixture.paints.size).toBe(0);
        expect(fixture.video.muted).toBe(false);
        expect(fixture.drawImage).not.toHaveBeenCalled();
    });

    it('starts a same-time read silently and waits for one paint, instead of trusting readyState', async () => {
        const fixture = videoFixture(4);
        let paint: FrameRequestCallback | undefined;
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { paint = callback; return 1; });
        const pending = readVideoFrame(fixture.video, {}, new AbortController().signal);
        await Promise.resolve();
        expect(fixture.video.play).toHaveBeenCalledTimes(1);
        expect(fixture.video.muted).toBe(true);
        expect(fixture.drawImage).not.toHaveBeenCalled();
        paint?.(0);
        await pending;
        expect(fixture.video.paused).toBe(true);
        expect(fixture.video.muted).toBe(false);
    });

    it('cancels a pending paint without drawing late pixels', async () => {
        const fixture = videoFixture(4);
        const cancel = vi.fn();
        vi.stubGlobal('requestAnimationFrame', () => 7);
        vi.stubGlobal('cancelAnimationFrame', cancel);
        const caller = new AbortController();
        const pending = readVideoFrame(fixture.video, { timeSeconds: 2, signal: caller.signal }, new AbortController().signal);
        const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
        fixture.finishSeek();
        await Promise.resolve();
        caller.abort();
        await rejected;
        expect(cancel).toHaveBeenCalledWith(7);
        expect(fixture.drawImage).not.toHaveBeenCalled();
        expect(fixture.video.currentTime).toBe(1);
    });

    it.each(['request', 'lifetime'] as const)('restores active playback after request cancellation but never resumes a retired %s', async (retired) => {
        const fixture = presentedFixture();
        await fixture.video.play();
        const lifetime = new AbortController();
        const caller = new AbortController();
        const pending = readVideoFrame(fixture.video, { timeSeconds: 2, signal: caller.signal }, lifetime.signal);
        const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
        fixture.finishSeek();
        await Promise.resolve();
        (retired === 'request' ? caller : lifetime).abort();
        await rejected;
        expect(fixture.video.paused).toBe(retired === 'lifetime');
        expect(fixture.video.muted).toBe(false);
        if (retired === 'request') expect(fixture.video.currentTime).toBe(1);
        expect(fixture.paints.size).toBe(0);
        expect(fixture.drawImage).not.toHaveBeenCalled();
    });

    it.each(['cancel', 'decode', 'play'] as const)('cleans pending presentation and restores a paused player when %s fails', async (failure) => {
        const fixture = presentedFixture();
        const add = vi.spyOn(fixture.video, 'addEventListener');
        const remove = vi.spyOn(fixture.video, 'removeEventListener');
        const caller = new AbortController();
        if (failure === 'play') vi.mocked(fixture.video.play).mockRejectedValue(new DOMException('Denied', 'NotAllowedError'));
        const pending = readVideoFrame(fixture.video, { timeSeconds: 2, signal: caller.signal }, new AbortController().signal);
        const rejected = expect(pending).rejects.toMatchObject({ name: failure === 'cancel' ? 'AbortError'
            : failure === 'decode' ? 'NotSupportedError' : 'NotAllowedError' });
        fixture.finishSeek();
        await Promise.resolve();
        if (failure === 'cancel') caller.abort();
        if (failure === 'decode') fixture.video.dispatchEvent(new Event('error'));
        await rejected;
        expect(fixture.paints.size).toBe(0);
        expect(remove.mock.calls).toHaveLength(add.mock.calls.length);
        expect(fixture.video.paused).toBe(true);
        expect(fixture.video.currentTime).toBe(1);
        expect(fixture.video.muted).toBe(false);
        fixture.present();
        expect(fixture.drawImage).not.toHaveBeenCalled();
    });

    it('waits for decoded seek, produces a PNG at source size, and restores the paused position after a thumbnail', async () => {
        const fixture = videoFixture();
        const lifetime = new AbortController();
        const frame = readVideoFrame(fixture.video, { timeSeconds: 2, width: 160 }, lifetime.signal);
        expect(fixture.drawImage).not.toHaveBeenCalled();
        fixture.finishSeek();
        const result = await frame;
        expect(result).toEqual({ uri: 'data:image/png;base64,cGl4ZWxz', width: 160, height: 90, timeSeconds: 2 });
        expect(fixture.drawImage).toHaveBeenCalledWith(fixture.video, 0, 0, 160, 90);
        expect(fixture.video.currentTime).toBe(1);
        fixture.finishSeek();
        const full = await readVideoFrame(fixture.video, {}, lifetime.signal);
        expect(full).toMatchObject({ width: 640, height: 360, timeSeconds: 1 });
    });

    it('releases pending decoder listeners on hide and caller cancellation, without polling or late drawing', async () => {
        const fixture = videoFixture();
        const lifetime = new AbortController();
        const caller = new AbortController();
        const add = vi.spyOn(fixture.video, 'addEventListener');
        const remove = vi.spyOn(fixture.video, 'removeEventListener');
        const interval = vi.spyOn(globalThis, 'setInterval');
        const timeout = vi.spyOn(globalThis, 'setTimeout');
        const pending = readVideoFrame(fixture.video, { timeSeconds: 2, signal: caller.signal }, lifetime.signal);
        const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
        lifetime.abort();
        await rejected;
        expect(remove.mock.calls).toHaveLength(add.mock.calls.length);
        fixture.finishSeek();
        expect(fixture.drawImage).not.toHaveBeenCalled();
        expect(interval).not.toHaveBeenCalled();
        expect(timeout).not.toHaveBeenCalled();
        const active = new AbortController();
        const second = readVideoFrame(fixture.video, { timeSeconds: 3, signal: caller.signal }, active.signal);
        const secondRejected = expect(second).rejects.toMatchObject({ name: 'AbortError' });
        caller.abort();
        await secondRejected;
    });

    it('surfaces canvas taint and media errors instead of returning a usable frame', async () => {
        const fixture = videoFixture();
        const lifetime = new AbortController();
        vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation(() => { throw new DOMException('Tainted', 'SecurityError'); });
        await expect(readVideoFrame(fixture.video, {}, lifetime.signal)).rejects.toMatchObject({ name: 'SecurityError' });
        const pending = readVideoFrame(fixture.video, { timeSeconds: 2 }, lifetime.signal);
        const failed = expect(pending).rejects.toMatchObject({ name: 'NotSupportedError' });
        fixture.video.dispatchEvent(new Event('error'));
        await failed;
    });

    it('does not draw if the player retires after seek completion but before the awaiting frame read resumes', async () => {
        const fixture = videoFixture();
        const lifetime = new AbortController();
        const pending = readVideoFrame(fixture.video, { timeSeconds: 2 }, lifetime.signal);
        const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
        fixture.finishSeek();
        lifetime.abort();
        await rejected;
        expect(fixture.drawImage).not.toHaveBeenCalled();
    });
});

describe('finite player source demand', () => {
    it('waits for the source and reads selected timestamps with one decoder, then releases it', async () => {
        const fixture = headlessFixture();
        const entered = vi.fn();
        const timeout = vi.spyOn(globalThis, 'setTimeout');
        const interval = vi.spyOn(globalThis, 'setInterval');
        const result = withVideoFrameSource('blob:recording', async (controls) => {
            entered();
            const frames = [];
            for (const timeSeconds of [2, 5, 9]) {
                const pending = controls.readFrame({ timeSeconds, width: 160 });
                fixture.finishSeek();
                frames.push(await pending);
                fixture.finishSeek();
            }
            controls.seekTo(4);
            fixture.finishSeek();
            frames.push(await controls.readFrame());
            return frames;
        });
        expect(entered).not.toHaveBeenCalled();
        expect(fixture.video.getAttribute('src')).toBe('blob:recording');
        fixture.finishLoad();
        const frames = await result;
        expect(frames.map((frame) => frame.timeSeconds)).toEqual([2, 5, 9, 4]);
        expect(fixture.create.mock.calls.filter(([tag]) => tag === 'video')).toHaveLength(1);
        expect(fixture.drawImage).toHaveBeenCalledTimes(4);
        expect(fixture.video.hasAttribute('src')).toBe(false);
        expect(fixture.video.load).toHaveBeenCalledTimes(1);
        expect(timeout).not.toHaveBeenCalled();
        expect(interval).not.toHaveBeenCalled();
    });

    it.each(['source', 'encoding'] as const)('releases the source when %s fails', async (phase) => {
        const fixture = headlessFixture();
        vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation(() => { throw new DOMException('Tainted', 'SecurityError'); });
        const result = withVideoFrameSource('blob:recording', (controls) => controls.readFrame());
        const rejected = expect(result).rejects.toMatchObject({ name: phase === 'source' ? 'NotSupportedError' : 'SecurityError' });
        if (phase === 'source') fixture.video.dispatchEvent(new Event('error'));
        else fixture.finishLoad();
        await rejected;
        expect(fixture.video.hasAttribute('src')).toBe(false);
        expect(fixture.video.load).toHaveBeenCalledTimes(1);
    });

    it.each(['loading', 'reading'] as const)('releases the source and pending decoder listeners on cancellation while %s', async (phase) => {
        const fixture = headlessFixture();
        const caller = new AbortController();
        const add = vi.spyOn(fixture.video, 'addEventListener');
        const remove = vi.spyOn(fixture.video, 'removeEventListener');
        const result = withVideoFrameSource('blob:recording', (controls) => controls.readFrame({ timeSeconds: 2 }), caller.signal);
        const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' });
        if (phase === 'reading') {
            fixture.finishLoad();
            await Promise.resolve();
            expect(fixture.video.currentTime).toBe(2);
        }
        caller.abort();
        await rejected;
        expect(fixture.video.hasAttribute('src')).toBe(false);
        expect(fixture.video.load).toHaveBeenCalledTimes(1);
        expect(remove.mock.calls).toHaveLength(add.mock.calls.length);
        fixture.finishSeek();
        expect(fixture.drawImage).not.toHaveBeenCalled();
    });
});
