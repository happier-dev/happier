import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createWebMicSession } from './WebMicSession.web';

describe('WebMicSession', () => {
    const trackStop = vi.fn();
    const trackListeners = new Map<string, EventListener>();
    const track = {
        enabled: true,
        stop: trackStop,
        addEventListener: vi.fn((event: string, listener: EventListener) => {
            trackListeners.set(event, listener);
        }),
        removeEventListener: vi.fn((event: string) => {
            trackListeners.delete(event);
        }),
    };
    const stream = {
        getAudioTracks: () => [track],
    } as unknown as MediaStream;
    const getUserMedia = vi.fn(async () => stream);
    const mediaDevices = {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
    };
    const documentLike = {
        visibilityState: 'visible' as DocumentVisibilityState,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
    };

    beforeEach(() => {
        track.enabled = true;
        trackStop.mockReset();
        trackListeners.clear();
        track.addEventListener.mockClear();
        track.removeEventListener.mockClear();
        getUserMedia.mockClear();
        mediaDevices.addEventListener.mockClear();
        mediaDevices.removeEventListener.mockClear();
        documentLike.addEventListener.mockClear();
        documentLike.removeEventListener.mockClear();
        documentLike.visibilityState = 'visible';
    });

    function createDeferred<T>() {
        let resolve!: (value: T | PromiseLike<T>) => void;
        let reject!: (reason?: unknown) => void;
        const promise = new Promise<T>((innerResolve, innerReject) => {
            resolve = innerResolve;
            reject = innerReject;
        });
        return { promise, resolve, reject };
    }

    it('mutes by toggling the active track enabled flag instead of stopping the stream', async () => {
        const session = createWebMicSession({
            getUserMedia,
            mediaDevices: mediaDevices as unknown as MediaDevices,
            document: documentLike as unknown as Document,
        });

        await session.ensureActive();
        session.setMuted(true);

        expect(track.enabled).toBe(false);
        expect(trackStop).not.toHaveBeenCalled();
    });

    it('stops active tracks on teardown', async () => {
        const session = createWebMicSession({
            getUserMedia,
            mediaDevices: mediaDevices as unknown as MediaDevices,
            document: documentLike as unknown as Document,
        });

        await session.ensureActive();
        await session.teardown();

        expect(trackStop).toHaveBeenCalledTimes(1);
    });

    it('reacquires the stream after the active track ends', async () => {
        const session = createWebMicSession({
            getUserMedia,
            mediaDevices: mediaDevices as unknown as MediaDevices,
            document: documentLike as unknown as Document,
        });

        await session.ensureActive();
        trackListeners.get('ended')?.(new Event('ended'));
        await session.ensureActive();

        expect(getUserMedia).toHaveBeenCalledTimes(2);
    });

    it('registers and removes device and visibility listeners with the active stream lifecycle', async () => {
        const session = createWebMicSession({
            getUserMedia,
            mediaDevices: mediaDevices as unknown as MediaDevices,
            document: documentLike as unknown as Document,
        });

        await session.ensureActive();

        expect(track.addEventListener).toHaveBeenCalledWith('ended', expect.any(Function));
        expect(track.addEventListener).toHaveBeenCalledWith('mute', expect.any(Function));
        expect(track.addEventListener).toHaveBeenCalledWith('unmute', expect.any(Function));
        expect(mediaDevices.addEventListener).toHaveBeenCalledWith('devicechange', expect.any(Function));
        expect(documentLike.addEventListener).toHaveBeenCalledWith('visibilitychange', expect.any(Function));

        await session.teardown();

        expect(track.removeEventListener).toHaveBeenCalledWith('ended', expect.any(Function));
        expect(track.removeEventListener).toHaveBeenCalledWith('mute', expect.any(Function));
        expect(track.removeEventListener).toHaveBeenCalledWith('unmute', expect.any(Function));
        expect(mediaDevices.removeEventListener).toHaveBeenCalledWith('devicechange', expect.any(Function));
        expect(documentLike.removeEventListener).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
    });

    it('dedupes concurrent ensureActive calls to a single getUserMedia request', async () => {
        const gate = createDeferred<void>();
        const gatedGetUserMedia = vi.fn(async () => {
            await gate.promise;
            return stream;
        });

        const session = createWebMicSession({
            getUserMedia: gatedGetUserMedia,
            mediaDevices: mediaDevices as unknown as MediaDevices,
            document: documentLike as unknown as Document,
        });

        const p1 = session.ensureActive();
        const p2 = session.ensureActive();

        expect(gatedGetUserMedia).toHaveBeenCalledTimes(1);

        gate.resolve(undefined);
        await Promise.all([p1, p2]);
    });

    it('normalizes browser permission denial into the standard mic_permission_denied error', async () => {
        const deniedGetUserMedia = vi.fn(async () => {
            throw { name: 'NotAllowedError' };
        });

        const session = createWebMicSession({
            getUserMedia: deniedGetUserMedia,
            mediaDevices: mediaDevices as unknown as MediaDevices,
            document: documentLike as unknown as Document,
        });

        await expect(session.ensureActive()).rejects.toThrow('mic_permission_denied');
        expect(deniedGetUserMedia).toHaveBeenCalledTimes(1);
    });
});
