import { beforeEach, describe, expect, it, vi } from 'vitest';

const sherpaNativeMock = vi.hoisted(() => ({
    nativeModule: null as null | object,
}));
const resolveNativeSileroVadBridgeMock = vi.hoisted(() => vi.fn());

vi.mock('@happier-dev/sherpa-native', () => ({
    getOptionalHappierSherpaNativeModule: () => sherpaNativeMock.nativeModule,
}));
vi.mock('./NativeSileroVadBridge', () => ({
    resolveNativeSileroVadBridge: resolveNativeSileroVadBridgeMock,
}));

import {
    createNativeVadController,
    type NativeVadBridge,
    type NativeVadSession,
} from './NativeVadController';

function createDeferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, reject, resolve };
}

function captureSynchronousError(callback: () => void): unknown | null {
    try {
        callback();
        return null;
    } catch (error) {
        return error;
    }
}

describe('createNativeVadController', () => {
    beforeEach(() => {
        sherpaNativeMock.nativeModule = null;
        resolveNativeSileroVadBridgeMock.mockReset();
        resolveNativeSileroVadBridgeMock.mockResolvedValue(null);
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
            endpoint: { reason: 'acoustic_endpoint', confidence: null },
        });
    });

    it('applies the two-stage confirmMs false-start debounce when the bridge surfaces speech-start edges', async () => {
        const onEndpointSignal = vi.fn();
        const onSpeechCandidateStart = vi.fn();
        const onSpeechCandidateFalseAlarm = vi.fn();
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
            onSpeechCandidateStart,
            onSpeechCandidateFalseAlarm,
            turnPolicy: { confirmMs: 800, silenceMs: 700 },
        });

        await controller.startSession({ minSpeechMs: 0, redemptionMs: 0, sessionId: 'session-native' });

        // Sub-confirmMs segment → suppressed.
        clock = 0;
        (onSpeechStart as null | (() => void))?.();
        clock = 300;
        (onSpeechEnd as null | (() => void))?.();
        expect(onEndpointSignal).not.toHaveBeenCalled();
        expect(onSpeechCandidateStart).toHaveBeenCalledWith({
            sessionId: 'session-native', source: 'native_vad',
        });
        expect(onSpeechCandidateFalseAlarm).toHaveBeenCalledWith({
            sessionId: 'session-native', source: 'native_vad',
        });

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
        expect(onSpeechCandidateStart).toHaveBeenCalledTimes(2);
        expect(onSpeechCandidateFalseAlarm).toHaveBeenCalledTimes(1);
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

    it('lets a matching immediate stop invalidate startup before the native bridge begins', async () => {
        const nativeStop = vi.fn(async () => {});
        const bridge: NativeVadBridge = {
            startSession: vi.fn(async () => ({ stop: nativeStop })),
        };
        const controller = createNativeVadController({
            bridge,
            onEndpointSignal: vi.fn(),
        });

        const starting = controller.startSession({
            minSpeechMs: 120,
            redemptionMs: 450,
            sessionId: 'session-native',
        });
        await expect(controller.stopSession('session-native')).resolves.toBeUndefined();

        await expect(starting).resolves.toBe(false);
        expect(bridge.startSession).not.toHaveBeenCalled();
        expect(nativeStop).not.toHaveBeenCalled();
        expect(controller.isActiveSession('session-native')).toBe(false);
    });

    it('isolates throwing observers from bridge callbacks and exactly-once native teardown', async () => {
        const nativeStop = vi.fn(async () => {});
        let clock = 0;
        let onSpeechStart: (() => void) | null = null;
        let onSpeechEnd: (() => void) | null = null;
        const bridge: NativeVadBridge = {
            startSession: vi.fn(async (args) => {
                onSpeechStart = args.onSpeechStart ?? null;
                onSpeechEnd = args.onSpeechEnd;
                return { stop: nativeStop };
            }),
        };
        const controller = createNativeVadController({
            bridge,
            now: () => clock,
            onEndpointSignal: () => {
                throw new Error('broken_endpoint_observer');
            },
            onSpeechCandidateStart: () => {
                throw new Error('broken_candidate_start_observer');
            },
            onSpeechCandidateFalseAlarm: () => {
                throw new Error('broken_candidate_false_alarm_observer');
            },
            turnPolicy: { confirmMs: 800, silenceMs: 700 },
        });

        await expect(controller.startSession({
            minSpeechMs: 0,
            redemptionMs: 0,
            sessionId: 'session-native',
        })).resolves.toBe(true);

        const callbackErrors: unknown[] = [];
        clock = 0;
        callbackErrors.push(captureSynchronousError(() => (onSpeechStart as null | (() => void))?.()));
        clock = 300;
        callbackErrors.push(captureSynchronousError(() => (onSpeechEnd as null | (() => void))?.()));
        callbackErrors.push(captureSynchronousError(() => (onSpeechEnd as null | (() => void))?.()));
        const stopError = await controller.stopSession('session-native').then(
            () => null,
            (error: unknown) => error,
        );

        expect(callbackErrors).toEqual([null, null, null]);
        expect(stopError).toBeNull();
        expect(nativeStop).toHaveBeenCalledTimes(1);
        expect(controller.isActiveSession('session-native')).toBe(false);
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
            endpoint: { reason: 'acoustic_endpoint', confidence: null },
        });

        await controller.stopSession('session-native');
        onEndpointSignal.mockClear();
        activeOnSpeechEnd?.();

        expect(stop).toHaveBeenCalledTimes(1);
        expect(onEndpointSignal).not.toHaveBeenCalled();
    });

    it('settles a matching stop while native startup is pending and disposes the late session', async () => {
        const pendingSession = createDeferred<NativeVadSession>();
        const lateStop = vi.fn(async () => {});
        const bridge: NativeVadBridge = {
            startSession: vi.fn(() => pendingSession.promise),
        };
        const onEndpointSignal = vi.fn();
        const controller = createNativeVadController({
            bridge,
            onEndpointSignal,
        });
        const starting = controller.startSession({
            minSpeechMs: 10,
            redemptionMs: 30,
            sessionId: 'session-native',
        });
        await vi.waitFor(() => expect(bridge.startSession).toHaveBeenCalledTimes(1));

        await expect(controller.stopSession('session-native')).resolves.toBeUndefined();
        pendingSession.resolve({ stop: lateStop });
        await expect(starting).resolves.toBe(false);

        expect(lateStop).toHaveBeenCalledTimes(1);
        expect(controller.isActiveSession('session-native')).toBe(false);
        expect(onEndpointSignal).not.toHaveBeenCalled();
    });

    it('does not cancel a pending native start for a different session', async () => {
        const pendingSession = createDeferred<NativeVadSession>();
        const stop = vi.fn(async () => {});
        const bridge: NativeVadBridge = {
            startSession: vi.fn(() => pendingSession.promise),
        };
        const controller = createNativeVadController({ bridge, onEndpointSignal: vi.fn() });
        const starting = controller.startSession({
            minSpeechMs: 10,
            redemptionMs: 30,
            sessionId: 'session-native',
        });
        await vi.waitFor(() => expect(bridge.startSession).toHaveBeenCalledTimes(1));

        await controller.stopSession('another-session');
        pendingSession.resolve({ stop });

        await expect(starting).resolves.toBe(true);
        expect(controller.isActiveSession('session-native')).toBe(true);
        expect(stop).not.toHaveBeenCalled();
    });

    it('invalidates an older pending start when a replacement begins', async () => {
        let resolveFirstStart!: (session: Readonly<{ stop(): Promise<void> }>) => void;
        const lateStop = vi.fn(async () => {});
        const activeStop = vi.fn(async () => {});
        const bridge: NativeVadBridge = {
            startSession: vi.fn()
                .mockImplementationOnce(async () => await new Promise((resolve) => {
                    resolveFirstStart = resolve;
                }))
                .mockResolvedValueOnce({ stop: activeStop }),
        };
        const controller = createNativeVadController({ bridge, onEndpointSignal: vi.fn() });
        const firstStart = controller.startSession({
            minSpeechMs: 10,
            redemptionMs: 30,
            sessionId: 'first-session',
        });
        await vi.waitFor(() => expect(bridge.startSession).toHaveBeenCalledTimes(1));

        await expect(controller.startSession({
            minSpeechMs: 10,
            redemptionMs: 30,
            sessionId: 'replacement-session',
        })).resolves.toBe(true);
        resolveFirstStart({ stop: lateStop });

        await expect(firstStart).resolves.toBe(false);
        expect(lateStop).toHaveBeenCalledTimes(1);
        expect(controller.isActiveSession('replacement-session')).toBe(true);
        expect(activeStop).not.toHaveBeenCalled();
    });

    it('keeps the replacement active when an older bridge resolution arrives late', async () => {
        const firstBridgeResolution = createDeferred<NativeVadBridge | null>();
        const staleNativeStop = vi.fn(async () => {});
        const replacementNativeStop = vi.fn(async () => {});
        const staleBridge: NativeVadBridge = {
            startSession: vi.fn(async () => ({ stop: staleNativeStop })),
        };
        const replacementBridge: NativeVadBridge = {
            startSession: vi.fn(async () => ({ stop: replacementNativeStop })),
        };
        resolveNativeSileroVadBridgeMock
            .mockReturnValueOnce(firstBridgeResolution.promise)
            .mockResolvedValueOnce(replacementBridge);
        const controller = createNativeVadController({ onEndpointSignal: vi.fn() });

        const firstStart = controller.startSession({
            minSpeechMs: 10,
            redemptionMs: 30,
            sessionId: 'first-session',
        });
        await vi.waitFor(() => expect(resolveNativeSileroVadBridgeMock).toHaveBeenCalledTimes(1));

        await expect(controller.startSession({
            minSpeechMs: 10,
            redemptionMs: 30,
            sessionId: 'replacement-session',
        })).resolves.toBe(true);
        firstBridgeResolution.resolve(staleBridge);

        await expect(firstStart).resolves.toBe(false);
        expect(staleBridge.startSession).not.toHaveBeenCalled();
        expect(replacementBridge.startSession).toHaveBeenCalledTimes(1);
        expect(replacementNativeStop).not.toHaveBeenCalled();
        expect(controller.isActiveSession('replacement-session')).toBe(true);
    });
});
