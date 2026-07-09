import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createWebMicSession } from './WebMicSession.web';

describe('WebMicSession', () => {
    const trackStop = vi.fn();
    const trackListeners = new Map<string, EventListener>();
    const track = {
        enabled: true,
        muted: false,
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
        track.muted = false;
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

    it('drives an audio level from the analyser RMS and stops the metering loop on teardown', async () => {
        // Fake analyser producing a constant half-scale time-domain signal so the
        // RMS is deterministic. getByteTimeDomainData fills 192 (center 128 + 64).
        const analyser = {
            fftSize: 0,
            disconnect: vi.fn(),
            getByteTimeDomainData: (buffer: Uint8Array) => {
                buffer.fill(192);
            },
        };
        const source = { connect: vi.fn(), disconnect: vi.fn() };
        const audioContext = {
            state: 'running' as AudioContextState,
            resume: vi.fn(async () => {}),
            close: vi.fn(async () => {}),
            createAnalyser: vi.fn(() => analyser),
            createMediaStreamSource: vi.fn(() => source),
        };

        const frameCallbacks: Array<() => void> = [];
        const onLevel = vi.fn();
        const session = createWebMicSession({
            getUserMedia,
            mediaDevices: mediaDevices as unknown as MediaDevices,
            document: documentLike as unknown as Document,
            createAudioContext: () => audioContext as unknown as AudioContext,
            requestLevelFrame: (cb) => {
                frameCallbacks.push(cb);
                return frameCallbacks.length;
            },
            cancelLevelFrame: vi.fn(),
            onLevel,
        });

        await session.ensureActive();
        // Run one metering frame.
        frameCallbacks.shift()?.();
        expect(onLevel).toHaveBeenCalled();
        const level = onLevel.mock.calls[0]![0] as number;
        // RMS of a constant 64/128 deviation is 0.5; the producer emits a positive
        // normalized level in (0,1].
        expect(level).toBeGreaterThan(0);
        expect(level).toBeLessThanOrEqual(1);

        await session.teardown();
        expect(source.disconnect).toHaveBeenCalled();
        // After teardown a stale queued frame must not keep emitting levels.
        onLevel.mockClear();
        frameCallbacks.shift()?.();
        expect(onLevel).not.toHaveBeenCalled();
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

    it('owns and exposes a shared AudioContext and resumes it on foreground', async () => {
        const resume = vi.fn(async () => {});
        const close = vi.fn(async () => {});
        const audioContext = { state: 'suspended' as AudioContextState, resume, close };
        const createAudioContext = vi.fn(() => audioContext as unknown as AudioContext);

        const session = createWebMicSession({
            getUserMedia,
            mediaDevices: mediaDevices as unknown as MediaDevices,
            document: documentLike as unknown as Document,
            createAudioContext,
        });

        await session.ensureActive();

        expect(createAudioContext).toHaveBeenCalledTimes(1);
        expect(session.getAudioContext?.()).toBe(audioContext);
        // resumed once during acquisition while suspended
        expect(resume).toHaveBeenCalledTimes(1);

        const visibilityHandler = documentLike.addEventListener.mock.calls.find(
            ([event]) => event === 'visibilitychange',
        )?.[1] as EventListener | undefined;
        documentLike.visibilityState = 'visible';
        visibilityHandler?.(new Event('visibilitychange'));

        expect(resume).toHaveBeenCalledTimes(2);
    });

    it('drops the stream and reports mic_ended only when devicechange leaves no audio inputs', async () => {
        const onFailure = vi.fn();
        let audioInputs: Array<{ kind: string }> = [{ kind: 'audioinput' }];
        const enumerateDevices = vi.fn(async () => audioInputs);
        const deviceMediaDevices = {
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
            enumerateDevices,
        };

        const session = createWebMicSession({
            getUserMedia,
            mediaDevices: deviceMediaDevices as unknown as MediaDevices,
            document: documentLike as unknown as Document,
            onFailure,
        });

        await session.ensureActive();
        const deviceChangeHandler = deviceMediaDevices.addEventListener.mock.calls.find(
            ([event]) => event === 'devicechange',
        )?.[1] as EventListener | undefined;

        // Route change: inputs still present -> no failure, stream preserved.
        deviceChangeHandler?.(new Event('devicechange'));
        await Promise.resolve();
        await Promise.resolve();
        expect(onFailure).not.toHaveBeenCalled();
        expect(session.getStream()).toBe(stream);

        // Input removed: no audio inputs -> drop stream and report mic_ended.
        audioInputs = [{ kind: 'audiooutput' }];
        deviceChangeHandler?.(new Event('devicechange'));
        await Promise.resolve();
        await Promise.resolve();
        expect(onFailure).toHaveBeenCalledWith({ kind: 'mic_ended', reason: 'web_mic_input_removed' });
        expect(session.getStream()).toBeNull();
    });

    it('debounces a transient track mute and only escalates a sustained mute', async () => {
        const onFailure = vi.fn();
        const timers = new Map<number, () => void>();
        let nextTimerId = 1;
        const setTimer = vi.fn((task: () => void) => {
            const id = nextTimerId++;
            timers.set(id, task);
            return id as unknown as ReturnType<typeof setTimeout>;
        });
        const clearTimer = vi.fn((id: ReturnType<typeof setTimeout>) => {
            timers.delete(id as unknown as number);
        });

        const session = createWebMicSession({
            getUserMedia,
            mediaDevices: mediaDevices as unknown as MediaDevices,
            document: documentLike as unknown as Document,
            onFailure,
            setTimer,
            clearTimer,
        });

        await session.ensureActive();

        // Transient mute -> unmute before the grace window: no failure.
        track.muted = true;
        trackListeners.get('mute')?.(new Event('mute'));
        expect(onFailure).not.toHaveBeenCalled();
        track.muted = false;
        trackListeners.get('unmute')?.(new Event('unmute'));
        // Pending escalation timer was cancelled.
        expect(timers.size).toBe(0);

        // Sustained mute: timer fires while still muted -> escalate.
        track.muted = true;
        trackListeners.get('mute')?.(new Event('mute'));
        const pending = Array.from(timers.values());
        expect(pending).toHaveLength(1);
        pending[0]?.();
        expect(onFailure).toHaveBeenCalledWith({ kind: 'audio_context_suspended', reason: 'web_mic_track_muted' });
    });
});
