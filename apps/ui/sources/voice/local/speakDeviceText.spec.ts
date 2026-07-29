import { beforeEach, describe, expect, it, vi } from 'vitest';

const speakSpy = vi.fn();
const stopSpy = vi.fn();
const { playbackLeaseRelease, acquirePlaybackLease } = vi.hoisted(() => {
    const release = vi.fn(async () => undefined);
    return {
        playbackLeaseRelease: release,
        acquirePlaybackLease: vi.fn(async () => Object.freeze({ release })),
    };
});

vi.mock('@/voice/runtime/voiceAudioMode', () => ({ acquireVoicePlaybackAudioMode: acquirePlaybackLease }));

vi.mock('expo-speech', () => ({
    speak: (text: string, opts: any) => speakSpy(text, opts),
    stop: () => stopSpy(),
}));

import { speakDeviceText, stopDeviceSpeech } from './speakDeviceText';

describe('speakDeviceText', () => {
    beforeEach(() => {
        acquirePlaybackLease.mockClear();
        playbackLeaseRelease.mockClear();
    });
    it('invokes onStart exactly once from the ExpoSpeech onStart event and resolves on onDone', async () => {
        speakSpy.mockReset();
        const onStart = vi.fn();
        let speechOptions: any = null;
        speakSpy.mockImplementationOnce((_text: string, opts: any) => {
            speechOptions = opts;
        });

        const speaking = speakDeviceText('hello', onStart);
        await vi.waitFor(() => expect(speakSpy).toHaveBeenCalledTimes(1));
        expect(onStart).not.toHaveBeenCalled();

        speechOptions.onStart();
        speechOptions.onStart();
        expect(onStart).toHaveBeenCalledTimes(1);
        speechOptions.onDone();
        await expect(speaking).resolves.toBeUndefined();
        expect(acquirePlaybackLease).toHaveBeenCalledTimes(1);
        expect(playbackLeaseRelease).toHaveBeenCalledTimes(1);
    });

    it('skips ExpoSpeech.speak when the abort signal is already aborted (pre-interrupt)', async () => {
        speakSpy.mockReset();
        const onStart = vi.fn();
        const controller = new AbortController();
        controller.abort();

        await expect(
            speakDeviceText('hello', onStart, { signal: controller.signal }),
        ).resolves.toBeUndefined();

        expect(speakSpy).not.toHaveBeenCalled();
        // onStart (the speaking transition) must not fire if we never speak.
        expect(onStart).not.toHaveBeenCalled();
    });

    it('skips ExpoSpeech.speak when interrupted while acquiring the playback lease', async () => {
        speakSpy.mockReset();
        const onStart = vi.fn();
        const controller = new AbortController();
        let resolveLease!: (lease: { release: typeof playbackLeaseRelease }) => void;
        const pendingLease = new Promise<{ release: typeof playbackLeaseRelease }>((resolve) => {
            resolveLease = resolve;
        });
        acquirePlaybackLease.mockReturnValueOnce(pendingLease);
        speakSpy.mockImplementationOnce((_text: string, opts: any) => opts.onDone());

        const speaking = speakDeviceText('hello', onStart, { signal: controller.signal });
        await vi.waitFor(() => expect(acquirePlaybackLease).toHaveBeenCalledTimes(1));
        controller.abort();
        resolveLease({ release: playbackLeaseRelease });

        await expect(speaking).resolves.toBeUndefined();
        expect(speakSpy).not.toHaveBeenCalled();
        expect(onStart).not.toHaveBeenCalled();
        expect(playbackLeaseRelease).toHaveBeenCalledTimes(1);
    });

    it('does not invoke onStart when ExpoSpeech fails before its onStart event', async () => {
        speakSpy.mockReset();
        const onStart = vi.fn();
        speakSpy.mockImplementationOnce((_text: string, opts: any) => {
            opts.onError(new Error('prestart_synth_failed'));
        });

        await expect(
            speakDeviceText('hi', onStart, { signal: new AbortController().signal }),
        ).rejects.toThrow('prestart_synth_failed');
        expect(onStart).not.toHaveBeenCalled();
    });

    it('does not invoke onStart when interrupted before ExpoSpeech reports playback start', async () => {
        speakSpy.mockReset();
        const onStart = vi.fn();
        const controller = new AbortController();
        speakSpy.mockImplementationOnce(() => undefined);

        const speaking = speakDeviceText('hi', onStart, { signal: controller.signal });
        await vi.waitFor(() => expect(speakSpy).toHaveBeenCalledTimes(1));
        controller.abort();

        await expect(speaking).resolves.toBeUndefined();
        expect(onStart).not.toHaveBeenCalled();
        expect(stopSpy).toHaveBeenCalledTimes(1);
    });

    it('rejects when ExpoSpeech reports an error', async () => {
        speakSpy.mockReset();
        speakSpy.mockImplementationOnce((_text: string, opts: any) => opts.onError(new Error('synth_boom')));
        await expect(speakDeviceText('hi')).rejects.toThrow('synth_boom');
        expect(playbackLeaseRelease).toHaveBeenCalledTimes(1);
    });

    it('stopDeviceSpeech calls ExpoSpeech.stop', () => {
        stopSpy.mockReset();
        stopDeviceSpeech();
        expect(stopSpy).toHaveBeenCalledTimes(1);
    });
});
