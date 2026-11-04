// @vitest-environment jsdom
import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { act, renderScreen, standardCleanup } from '@/dev/testkit';
import { HeldVideoPlayer } from './HeldVideoPlayer';
import type { MediaPlayerVideoControls } from './videoFrameAccess';

const native = vi.hoisted(() => ({ listeners: new Map<string, (event: { isPlaying: boolean }) => void>(),
    play: vi.fn(), pause: vi.fn(), video: null as HTMLVideoElement | null, status: 'readyToPlay' as 'readyToPlay' | 'error' }));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
// Expo playback/event delivery is the external video boundary.
vi.mock('expo-video', async () => {
    const React = await import('react');
    return {
        VideoView: React.forwardRef((props: Record<string, unknown>, ref) => {
            React.useImperativeHandle(ref, () => ({ nativeRef: { current: native.video } }));
            return React.createElement('VideoView', props);
        }),
        useVideoPlayer: () => React.useMemo(() => ({ status: native.status,
            get currentTime() { return native.video?.currentTime ?? 0; },
            set currentTime(value: number) { if (native.video) native.video.currentTime = value; },
            play: native.play, pause: native.pause,
            addListener: (name: string, listener: (event: { isPlaying: boolean }) => void) => {
                native.listeners.set(name, listener); return { remove: () => native.listeners.delete(name) };
            },
        }), []),
    };
});
afterEach(async () => { await standardCleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); native.play.mockReset(); native.pause.mockReset(); native.video = null; native.listeners.clear(); native.status = 'readyToPlay'; });

it.each([false, true])('restores host playing=%s after a read starts during decoder priming', async playing => {
    const video = document.createElement('video');
    native.video = video;
    let paused = true;
    let paint: FrameRequestCallback | undefined;
    Object.defineProperties(video, {
        readyState: { value: 4 }, videoWidth: { value: 4 }, videoHeight: { value: 4 },
        paused: { get: () => paused },
    });
    video.currentTime = 15.425;
    vi.spyOn(video, 'play').mockImplementation(async () => { paused = false; });
    vi.spyOn(video, 'pause').mockImplementation(() => { paused = true; });
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { paint = callback; return 1; });
    vi.stubGlobal('cancelAnimationFrame', () => {});
    const drawImage = vi.fn();
    // Canvas pixels and Expo's video element are browser/media system boundaries.
    vi.spyOn<{ getContext(contextId: '2d'): CanvasRenderingContext2D | null }, 'getContext'>(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,AQID');
    native.play.mockImplementation(() => { void video.play(); });
    native.pause.mockImplementation(() => video.pause());
    let controls: MediaPlayerVideoControls | null = null;
    await renderScreen(<HeldVideoPlayer uri="blob:movie" title="movie" chrome="none" isActive onError={() => {}}
        onVideoControls={value => { controls = value; }} />);
    if (playing) controls!.playback!.play();
    // A previous frame request's priming must never become host playback intent.
    await video.play();
    const pending = controls!.readFrame();
    await Promise.resolve();
    paint!(0);
    await pending;
    expect(video.paused).toBe(!playing);
    expect(video.currentTime).toBe(15.425);
    expect(drawImage).toHaveBeenCalledTimes(1);
});

it('reports an already-failed player when the error preceded subscription', async () => {
    native.status = 'error';
    const onError = vi.fn();
    await renderScreen(<HeldVideoPlayer uri="blob:movie" title="movie" chrome="none" isActive onError={onError} />);
    expect(onError).toHaveBeenCalledWith(expect.any(String));
});

it('settles explicit Pause on the held picture when a short track supplies neither another frame callback nor ended', async () => {
    const video = document.createElement('video');
    native.video = video;
    let paused = true;
    const paints: FrameRequestCallback[] = [];
    Object.defineProperties(video, {
        readyState: { value: 4 }, videoWidth: { value: 600 }, videoHeight: { value: 400 },
        duration: { value: 50.803333 }, paused: { get: () => paused },
    });
    // The encoded static track ends at .555s, while WebKit keeps the movie clock running.
    video.currentTime = 0.54;
    vi.spyOn(video, 'play').mockImplementation(async () => { paused = false; });
    vi.spyOn(video, 'pause').mockImplementation(() => { paused = true; });
    Object.assign(video, { requestVideoFrameCallback: vi.fn(() => 1), cancelVideoFrameCallback: vi.fn() });
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { paints.push(callback); return paints.length; });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const drawImage = vi.fn();
    vi.spyOn<{ getContext(contextId: '2d'): CanvasRenderingContext2D | null }, 'getContext'>(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,held-green');
    native.play.mockImplementation(() => { void video.play(); });
    native.pause.mockImplementation(() => video.pause());
    let controls: MediaPlayerVideoControls | null = null;
    await renderScreen(<HeldVideoPlayer uri="blob:short-static-track" title="movie" chrome="none" isActive onError={() => {}}
        onVideoControls={value => { controls = value; }} />);
    const caller = new AbortController();
    controls!.playback!.play();
    controls!.playback!.pause();
    const pending = controls!.readFrame({ timeSeconds: 0.54, signal: caller.signal });
    const result = pending.catch(() => null);
    try {
        await Promise.resolve();
        for (const paint of paints.splice(0)) paint(0);
        expect(video.paused).toBe(true);
        expect(await result).toMatchObject({ uri: 'data:image/png;base64,held-green', timeSeconds: 0.54 });
        expect(video.paused).toBe(true);
        expect(video.muted).toBe(false);
        expect(drawImage).toHaveBeenCalledTimes(1);
    } finally {
        caller.abort();
        await result;
        vi.unstubAllGlobals();
    }
});

it('publishes editor playback intent while decoder priming events stay invisible', async () => {
    let controls: MediaPlayerVideoControls | null = null;
    const onControls = (value: MediaPlayerVideoControls | null) => { controls = value; };
    await renderScreen(<HeldVideoPlayer uri="blob:movie" title="movie" chrome="none" isActive onError={() => {}} onVideoControls={onControls} />);
    const playback = controls!.playback!;
    const changes: boolean[] = [];
    const unsubscribe = playback.subscribe(value => changes.push(value));
    await act(async () => {
        native.listeners.get('playingChange')?.({ isPlaying: true });
        native.listeners.get('playingChange')?.({ isPlaying: false });
    });
    expect(changes).toEqual([]);
    await act(async () => { playback.play(); playback.pause(); });
    expect(changes).toEqual([true, false]);
    unsubscribe();
});
