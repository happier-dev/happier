import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpeechOptions } from 'expo-speech';
import { createNativeVoicePcmCaptureHarness } from '@/dev/testkit/harness/nativeVoicePcmCapture';
import { getSharedVoiceAudioSessionCoordinator } from '@happier-dev/audio-stream-native';
import { createDeferred } from '@/dev/testkit';

const speakSpy = vi.fn<(text: string, options: SpeechOptions) => void>();
const stopSpy = vi.fn<() => Promise<void>>();
const audioSession = createNativeVoicePcmCaptureHarness();

vi.mock('expo-modules-core', async (importOriginal) => {
    const actual = await importOriginal<typeof import('expo-modules-core')>();
    return { ...actual, requireOptionalNativeModule: (name: string) =>
        name === 'HappierAudioStreamNative' ? audioSession.nativeModule : actual.requireOptionalNativeModule(name) };
});
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ Platform: { OS: 'ios' } });
});

vi.mock('expo-speech', () => ({
    speak: (text: string, opts: SpeechOptions) => speakSpy(text, opts),
    stop: () => stopSpy(),
}));

import { speakDeviceText } from './speakDeviceText';
import { createVoiceMachineError } from '@/voice/runtime/machine/voiceMachineError';

describe('speakDeviceText', () => {
    it('retains the browser synthesis event code through the published Voice cause', async () => {
        speakSpy.mockImplementationOnce((_text, opts) => {
            // Expo Speech web forwards SpeechSynthesisErrorEvent, not an Error.
            // Expo's native Error annotation omits its actual web event shape.
            const onError = opts.onError as ((event: unknown) => void) | undefined;
            onError?.({ error: 'synthesis-failed', charIndex: 0, utterance: { text: 'private greeting' } });
        });
        const error = await speakDeviceText('private greeting').catch((cause: unknown) => cause);
        expect(createVoiceMachineError({ kind: 'tts_failed', reason: 'tts_failed', cause: error }))
            .toMatchObject({ failureCause: { phase: 'voice.tts.device', nativeErrorCode: 'synthesis-failed' } });
        expect(JSON.stringify(error)).not.toContain('private greeting');
        expect(getSharedVoiceAudioSessionCoordinator()!.getSnapshot().leaseCount).toBe(0);
    });
    beforeEach(() => {
        vi.mocked(audioSession.nativeModule.configureAudioSession).mockClear();
        speakSpy.mockReset();
        stopSpy.mockReset();
        stopSpy.mockResolvedValue(undefined);
    });
    afterAll(async () => { await getSharedVoiceAudioSessionCoordinator()?.dispose(); await audioSession.coordinator.dispose(); });
    it('invokes onStart exactly once from the ExpoSpeech onStart event and resolves on onDone', async () => {
        speakSpy.mockReset();
        const onStart = vi.fn();
        let speechOptions: SpeechOptions | undefined;
        const speechEntered = createDeferred<void>();
        speakSpy.mockImplementationOnce((_text: string, opts: SpeechOptions) => {
            speechOptions = opts;
            speechEntered.resolve();
        });

        const speaking = speakDeviceText('hello', onStart);
        await speechEntered.promise;
        expect(speakSpy).toHaveBeenCalledTimes(1);
        expect(onStart).not.toHaveBeenCalled();

        expect(getSharedVoiceAudioSessionCoordinator()!.getSnapshot()).toMatchObject({ leaseCount: 1,
            configuration: { mode: 'playback', input: false, output: true } });
        speechOptions!.onStart?.();
        speechOptions!.onStart?.();
        expect(onStart).toHaveBeenCalledTimes(1);
        speechOptions!.onDone?.();
        await expect(speaking).resolves.toBeUndefined();
        expect(getSharedVoiceAudioSessionCoordinator()!.getSnapshot()).toMatchObject({ leaseCount: 0, configuration: null });
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

    it.each(['abort', 'retire'] as const)('skips ExpoSpeech.speak after %s while acquiring the playback lease', async reason => {
        speakSpy.mockReset();
        const onStart = vi.fn();
        const controller = new AbortController();
        let current = true;
        let resolveApply!: () => void;
        const configurationEntered = createDeferred<void>();
        vi.mocked(audioSession.nativeModule.configureAudioSession).mockImplementationOnce(request => new Promise(resolve => {
            resolveApply = () => resolve({ generation: request.generation, aecAvailable: true, aecActive: false, route: 'speaker' });
            configurationEntered.resolve();
        }));
        speakSpy.mockImplementationOnce((_text: string, opts: SpeechOptions) => opts.onDone?.());

        const speaking = speakDeviceText('hello', onStart, { signal: controller.signal, isCurrent: () => current });
        await configurationEntered.promise;
        expect(audioSession.nativeModule.configureAudioSession).toHaveBeenCalledTimes(1);
        if (reason === 'abort') controller.abort();
        else current = false;
        resolveApply();

        await expect(speaking).resolves.toBeUndefined();
        expect(speakSpy).not.toHaveBeenCalled();
        expect(onStart).not.toHaveBeenCalled();
        expect(getSharedVoiceAudioSessionCoordinator()!.getSnapshot().leaseCount).toBe(0);
    });

    it('does not invoke onStart when ExpoSpeech fails before its onStart event', async () => {
        speakSpy.mockReset();
        const onStart = vi.fn();
        speakSpy.mockImplementationOnce((_text: string, opts: SpeechOptions) => {
            opts.onError?.(new Error('prestart_synth_failed'));
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
        const speechEntered = createDeferred<void>();
        speakSpy.mockImplementationOnce(() => speechEntered.resolve());

        const speaking = speakDeviceText('hi', onStart, { signal: controller.signal });
        await speechEntered.promise;
        expect(speakSpy).toHaveBeenCalledTimes(1);
        controller.abort();

        await expect(speaking).resolves.toBeUndefined();
        expect(onStart).not.toHaveBeenCalled();
        expect(stopSpy).toHaveBeenCalledTimes(1);
    });

    it('rejects when ExpoSpeech reports an error', async () => {
        speakSpy.mockReset();
        speakSpy.mockImplementationOnce((_text: string, opts: SpeechOptions) => opts.onError?.(new Error('synth_boom')));
        await expect(speakDeviceText('hi')).rejects.toThrow('synth_boom');
        expect(getSharedVoiceAudioSessionCoordinator()!.getSnapshot().leaseCount).toBe(0);
    });

});
