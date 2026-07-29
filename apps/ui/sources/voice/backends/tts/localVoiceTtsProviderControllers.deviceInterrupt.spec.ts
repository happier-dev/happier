import { describe, expect, it, vi } from 'vitest';

const speakDeviceTextSpy = vi.fn(async (_text: string, _onStart?: () => void, _opts?: unknown) => undefined);
const stopDeviceSpeechSpy = vi.fn();

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ Platform: { OS: 'ios' } });
});

vi.mock('@/voice/local/speakDeviceText', () => ({
    speakDeviceText: (text: string, onStart?: () => void, opts?: unknown) => speakDeviceTextSpy(text, onStart, opts),
    stopDeviceSpeech: () => stopDeviceSpeechSpy(),
}));

vi.mock('@/voice/credentials/bundledSpeechClient', () => ({
    bundledSpeechDaemonClient: { transcribe: vi.fn(), synthesize: vi.fn() },
}));
vi.mock('@/voice/output/TtsController', () => ({ speakOpenAiCompatText: vi.fn() }));
vi.mock('@/voice/output/KokoroTtsController', () => ({ speakKokoroText: vi.fn() }));

import { createDefaultLocalVoiceTtsProviderControllers } from './localVoiceTtsProviderControllers';

function baseCtx(over: Partial<Record<string, unknown>> = {}) {
    return {
        sessionId: 's1',
        text: 'hello there',
        settings: {},
        tts: { provider: 'device' },
        networkTimeoutMs: 15_000,
        onSpeaking: vi.fn(),
        registerPlaybackStopper: (_stopper: () => void) => () => {},
        ...over,
    } as any;
}

describe('device TTS provider controller', () => {
    it('passes an abort signal into speakDeviceText that fires when the playback stopper runs', async () => {
        speakDeviceTextSpy.mockReset();
        let capturedSignal: AbortSignal | null = null;
        speakDeviceTextSpy.mockImplementationOnce(async (_t, _onStart, opts: any) => {
            capturedSignal = opts?.signal ?? null;
        });

        let registeredStopper: (() => void) | null = null;
        const controllers = createDefaultLocalVoiceTtsProviderControllers();
        await controllers.get('device')!.speak(baseCtx({
            registerPlaybackStopper: (stopper: () => void) => {
                registeredStopper = stopper;
                return () => {};
            },
        }));

        expect(capturedSignal).toBeInstanceOf(AbortSignal);
        expect(capturedSignal!.aborted).toBe(false);
        registeredStopper!();
        expect(capturedSignal!.aborted).toBe(true);
        expect(stopDeviceSpeechSpy).not.toHaveBeenCalled();
    });

    it('skips device speech when the stopper fires before synth (pre-interrupt)', async () => {
        speakDeviceTextSpy.mockReset();
        // Real speakDeviceText behavior: when signal already aborted, it returns without speaking.
        speakDeviceTextSpy.mockImplementation(async (_t, onStart: any, opts: any) => {
            if (opts?.signal?.aborted) return;
            onStart?.();
        });

        const onSpeaking = vi.fn();
        const controllers = createDefaultLocalVoiceTtsProviderControllers();
        await controllers.get('device')!.speak(baseCtx({
            onSpeaking,
            // Fire the stopper synchronously on registration (mirrors a pending interrupt).
            registerPlaybackStopper: (stopper: () => void) => {
                stopper();
                return () => {};
            },
        }));

        expect(speakDeviceTextSpy).toHaveBeenCalledTimes(1);
        const opts = speakDeviceTextSpy.mock.calls[0]?.[2] as any;
        expect(opts?.signal?.aborted).toBe(true);
        // No speaking transition because we never started audio.
        expect(onSpeaking).not.toHaveBeenCalled();
    });

    it('emits tts_failed (recoverable) via onTtsFailed when device synth throws', async () => {
        speakDeviceTextSpy.mockReset();
        speakDeviceTextSpy.mockRejectedValueOnce(new Error('device_synth_boom'));

        const onTtsFailed = vi.fn();
        const controllers = createDefaultLocalVoiceTtsProviderControllers();
        await controllers.get('device')!.speak(baseCtx({ onTtsFailed }));

        expect(onTtsFailed).toHaveBeenCalledTimes(1);
        const err = onTtsFailed.mock.calls[0]?.[0];
        expect(err.kind).toBe('tts_failed');
        expect(err.recoverable).toBe(true);
    });

    it('does not emit tts_failed when the failure is an abort (interrupt)', async () => {
        speakDeviceTextSpy.mockReset();
        speakDeviceTextSpy.mockRejectedValueOnce(Object.assign(new Error('turn_aborted'), { name: 'AbortError' }));

        const onTtsFailed = vi.fn();
        const controllers = createDefaultLocalVoiceTtsProviderControllers();
        await controllers.get('device')!.speak(baseCtx({ onTtsFailed }));

        expect(onTtsFailed).not.toHaveBeenCalled();
    });
});
