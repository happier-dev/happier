import { beforeEach, describe, expect, it, vi } from 'vitest';

const sherpaNativeMock = vi.hoisted(() => ({
    nativeModule: null as null | {
        addListener?: (eventName: string, listener: (event: unknown) => void) => { remove: () => void };
        startVadSession?: (params: { minSpeechMs: number; redemptionMs: number; sessionId: string }) => void | Promise<void>;
        stopVadSession?: (params: { sessionId: string }) => void | Promise<void>;
    },
}));

vi.mock('@happier-dev/sherpa-native', () => ({
    getOptionalHappierSherpaNativeModule: () => sherpaNativeMock.nativeModule,
}));

import { createNativeVadController, type NativeVadBridge } from './NativeVadController';

describe('createNativeVadController', () => {
    beforeEach(() => {
        sherpaNativeMock.nativeModule = null;
    });

    it('adapts the optional native Silero bridge contract when the native module exposes it', async () => {
        const onEndpointSignal = vi.fn();
        const remove = vi.fn();
        const startVadSession = vi.fn(async () => {});
        const stopVadSession = vi.fn(async () => {});
        let vadSpeechEndListener: ((event: unknown) => void) | null = null;
        let vadSpeechStartListener: ((event: unknown) => void) | null = null;
        sherpaNativeMock.nativeModule = {
            addListener: vi.fn((eventName, listener) => {
                if (eventName === 'vadSpeechEnd') {
                    vadSpeechEndListener = listener;
                }
                if (eventName === 'vadSpeechStart') {
                    vadSpeechStartListener = listener;
                }
                return { remove };
            }),
            startVadSession,
            stopVadSession,
        };
        const controller = createNativeVadController({
            now: () => 9_001,
            onEndpointSignal,
        });

        await expect(controller.startSession({
            minSpeechMs: 120.4,
            redemptionMs: 450.6,
            sessionId: ' native-silero ',
        })).resolves.toBe(true);

        expect(startVadSession).toHaveBeenCalledWith({
            minSpeechMs: 120,
            redemptionMs: 451,
            sessionId: 'native-silero',
        });

        expect(typeof vadSpeechEndListener).toBe('function');
        // The bridge also subscribes the optional speech-START edge so the
        // two-stage hysteresis machine can debounce false starts.
        expect(typeof vadSpeechStartListener).toBe('function');
        if (!vadSpeechEndListener) {
            throw new Error('expected native VAD speech-end listener');
        }
        const activeVadSpeechEndListener: (event: unknown) => void = vadSpeechEndListener;
        activeVadSpeechEndListener({ sessionId: 'native-silero' });

        expect(onEndpointSignal).toHaveBeenCalledWith({
            detectedAt: 9_001,
            sessionId: 'native-silero',
            source: 'native_vad',
            transcript: '',
            // VAD-only edge (no observed speech-start) → duration is unknown.
            durationMs: null,
        });

        await controller.stopSession('native-silero');

        // Both the speech-end and speech-start subscriptions are torn down.
        expect(remove).toHaveBeenCalledTimes(2);
        expect(stopVadSession).toHaveBeenCalledWith({ sessionId: 'native-silero' });
    });

    it('carries the latest partial transcript on the native_vad signal when a provider is supplied', async () => {
        const onEndpointSignal = vi.fn();
        const stop = vi.fn();
        let onSpeechEnd: (() => void) | null = null;
        let partial = 'open the';
        const bridge: NativeVadBridge = {
            startSession: vi.fn(async (args) => {
                onSpeechEnd = args.onSpeechEnd;
                return { stop };
            }),
        };
        const controller = createNativeVadController({
            bridge,
            now: () => 7_000,
            onEndpointSignal,
            getLatestPartialTranscript: () => partial,
        });

        await controller.startSession({ minSpeechMs: 10, redemptionMs: 30, sessionId: 'session-native' });
        partial = 'open the most recent notes';
        (onSpeechEnd as null | (() => void))?.();

        expect(onEndpointSignal).toHaveBeenCalledWith({
            detectedAt: 7_000,
            sessionId: 'session-native',
            source: 'native_vad',
            transcript: 'open the most recent notes',
            // VAD-only edge (no observed speech-start) → duration is unknown.
            durationMs: null,
        });
    });

    it('applies the two-stage confirmMs false-start debounce when the bridge surfaces speech-start edges', async () => {
        const onEndpointSignal = vi.fn();
        const stop = vi.fn();
        let clock = 0;
        let onSpeechStart: (() => void) | null = null;
        let onSpeechEnd: (() => void) | null = null;
        const bridge: NativeVadBridge = {
            startSession: vi.fn(async (args) => {
                onSpeechStart = args.onSpeechStart ?? null;
                onSpeechEnd = args.onSpeechEnd;
                return { stop };
            }),
        };
        const controller = createNativeVadController({
            bridge,
            now: () => clock,
            onEndpointSignal,
            turnPolicy: { confirmMs: 800, silenceMs: 700 },
        });

        await controller.startSession({ minSpeechMs: 0, redemptionMs: 0, sessionId: 'session-native' });

        // Sub-confirmMs segment → suppressed.
        clock = 0;
        (onSpeechStart as null | (() => void))?.();
        clock = 300;
        (onSpeechEnd as null | (() => void))?.();
        expect(onEndpointSignal).not.toHaveBeenCalled();

        // Sustained segment → emits, carrying the measured speech-start → endpoint
        // span (1000 → 2000) so the downstream barge-in duration gate sees it.
        clock = 1_000;
        (onSpeechStart as null | (() => void))?.();
        clock = 2_000;
        (onSpeechEnd as null | (() => void))?.();
        expect(onEndpointSignal).toHaveBeenCalledTimes(1);
        expect(onEndpointSignal).toHaveBeenCalledWith(expect.objectContaining({
            source: 'native_vad',
            durationMs: 1_000,
        }));
    });

    it('returns false without a native bridge so provider endpoint fallbacks remain active', async () => {
        const onEndpointSignal = vi.fn();
        const controller = createNativeVadController({
            onEndpointSignal,
        });

        await expect(controller.startSession({
            minSpeechMs: 120,
            redemptionMs: 450,
            sessionId: 'session-native',
        })).resolves.toBe(false);

        expect(controller.isActiveSession('session-native')).toBe(false);
        expect(onEndpointSignal).not.toHaveBeenCalled();
    });

    it('returns false when the optional native module does not expose the Silero VAD contract', async () => {
        sherpaNativeMock.nativeModule = {
            startVadSession: vi.fn(),
        };
        const onEndpointSignal = vi.fn();
        const controller = createNativeVadController({
            onEndpointSignal,
        });

        await expect(controller.startSession({
            minSpeechMs: 120,
            redemptionMs: 450,
            sessionId: 'session-native',
        })).resolves.toBe(false);

        expect(controller.isActiveSession('session-native')).toBe(false);
        expect(onEndpointSignal).not.toHaveBeenCalled();
    });

    it('emits runtime-owned native_vad endpoint signals from the active bridge session', async () => {
        const onEndpointSignal = vi.fn();
        const stop = vi.fn();
        let onSpeechEnd: (() => void) | null = null;
        const bridge: NativeVadBridge = {
            startSession: vi.fn(async (args) => {
                onSpeechEnd = args.onSpeechEnd;
                return { stop };
            }),
        };
        const controller = createNativeVadController({
            bridge,
            now: () => 1_234,
            onEndpointSignal,
        });

        await expect(controller.startSession({
            minSpeechMs: 10.2,
            redemptionMs: 30.6,
            sessionId: ' session-native ',
        })).resolves.toBe(true);

        expect(bridge.startSession).toHaveBeenCalledWith(expect.objectContaining({
            minSpeechMs: 10,
            redemptionMs: 31,
            sessionId: 'session-native',
        }));

        const activeOnSpeechEnd = onSpeechEnd as null | (() => void);
        activeOnSpeechEnd?.();

        expect(onEndpointSignal).toHaveBeenCalledWith({
            detectedAt: 1_234,
            sessionId: 'session-native',
            source: 'native_vad',
            transcript: '',
            // VAD-only edge (no observed speech-start) → duration is unknown.
            durationMs: null,
        });

        await controller.stopSession('session-native');
        onEndpointSignal.mockClear();
        activeOnSpeechEnd?.();

        expect(stop).toHaveBeenCalledTimes(1);
        expect(onEndpointSignal).not.toHaveBeenCalled();
    });
});
