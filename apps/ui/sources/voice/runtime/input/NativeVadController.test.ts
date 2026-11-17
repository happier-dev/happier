import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeferred } from '@/dev/testkit';
import { createNativeVoicePcmCaptureHarness } from '@/dev/testkit/harness/nativeVoicePcmCapture';

const nativeBoundary = vi.hoisted(() => ({
    module: null as object | null,
}));
const nativeAudio = createNativeVoicePcmCaptureHarness();
// One installed audio module per app lifetime; the actual package registry owns
// coordinator/capture identity. Sherpa availability is an external SDK lookup.
vi.mock('expo-modules-core', async original => {
    const actual = await original<typeof import('expo-modules-core')>();
    return { ...actual, requireOptionalNativeModule: (name: string) => name === 'HappierAudioStreamNative'
        ? nativeAudio.nativeModule : name === 'HappierSherpaNative' ? nativeBoundary.module : actual.requireOptionalNativeModule(name) };
});
const { loadSyncSingletonForTests } = await import('@/dev/testkit/harness/syncSingletonLoader');
await loadSyncSingletonForTests();
const { getSharedVoicePcmCapture, getSharedVoiceAudioSessionCoordinator } = await import('@happier-dev/audio-stream-native');
const installedCapture = getSharedVoicePcmCapture();
if (!installedCapture) throw new Error('Installed native capture unavailable');
const capture = installedCapture;
const { createNativeVadController } = await import('./NativeVadController');
afterAll(async () => {
    await getSharedVoiceAudioSessionCoordinator()?.dispose();
    await nativeAudio.coordinator.dispose();
});

function installNativeBoundary() {
    const harness = { ...nativeAudio, capture };
    const createVadDetector = vi.fn(async (_request: Readonly<{
        detectorId: string; minSpeechMs: number; redemptionMs: number; sampleRate: number;
    }>) => {});
    const pushVadAudioFrame = vi.fn(async () => ({ speechStarted: false, speechEnded: false }));
    const cancelVadDetector = vi.fn(async (_request: Readonly<{ detectorId: string }>) => {});
    nativeBoundary.module = { createVadDetector, pushVadAudioFrame, cancelVadDetector };
    return { ...harness, createVadDetector, pushVadAudioFrame, cancelVadDetector,
        frame: async (edge: Readonly<{ speechStarted: boolean; speechEnded: boolean }>) => {
            pushVadAudioFrame.mockResolvedValueOnce(edge);
            harness.emit();
            await harness.capture.waitForDrain();
        },
    };
}
beforeEach(() => { vi.clearAllMocks(); nativeBoundary.module = null; });

describe('native VAD controller through real bridge and capture', () => {
    it('carries the current partial transcript and measured duration at the native endpoint', async () => {
        const native = installNativeBoundary();
        let clock = 7_000;
        let partial = 'open the';
        const onEndpointSignal = vi.fn();
        const controller = createNativeVadController({ now: () => clock, onEndpointSignal,
            getLatestPartialTranscript: () => partial, turnPolicy: { confirmMs: 10 } });
        expect(await controller.startSession({ minSpeechMs: 10, redemptionMs: 30, sessionId: 'session-native' })).toBe(true);
        await native.frame({ speechStarted: true, speechEnded: false });
        partial = 'open the most recent notes';
        clock = 7_040;
        await native.frame({ speechStarted: false, speechEnded: true });
        expect(onEndpointSignal).toHaveBeenCalledWith({ detectedAt: 7_040, sessionId: 'session-native',
            source: 'native_vad', transcript: partial, durationMs: 40,
            endpoint: { reason: 'acoustic_endpoint', confidence: null } });
        await controller.stopSession();
        expect(native.capture.getSnapshot().subscriberCount).toBe(0);
    });
    it('suppresses false starts while sustained native speech admits one endpoint', async () => {
        const native = installNativeBoundary();
        let clock = 0;
        const onEndpointSignal = vi.fn();
        const onSpeechCandidateStart = vi.fn();
        const onSpeechCandidateFalseAlarm = vi.fn();
        const controller = createNativeVadController({ now: () => clock, onEndpointSignal,
            onSpeechCandidateStart, onSpeechCandidateFalseAlarm, turnPolicy: { confirmMs: 800, silenceMs: 700 } });
        await controller.startSession({ minSpeechMs: 0, redemptionMs: 0, sessionId: 'session-native' });
        await native.frame({ speechStarted: true, speechEnded: false });
        clock = 300;
        await native.frame({ speechStarted: false, speechEnded: true });
        expect(onEndpointSignal).not.toHaveBeenCalled();
        expect(onSpeechCandidateFalseAlarm).toHaveBeenCalledWith({ sessionId: 'session-native', source: 'native_vad' });
        clock = 1_000;
        await native.frame({ speechStarted: true, speechEnded: false });
        clock = 2_000;
        await native.frame({ speechStarted: false, speechEnded: true });
        expect(onEndpointSignal.mock.calls.map(([signal]) => signal.durationMs)).toEqual([1_000]);
        expect(onSpeechCandidateStart).toHaveBeenCalledTimes(2);
        await controller.stopSession();
    });
    it('keeps provider fallbacks available without the installed native capability', async () => {
        const controller = createNativeVadController({ onEndpointSignal: vi.fn() });
        expect(await controller.startSession({ minSpeechMs: 120, redemptionMs: 450, sessionId: 'session-native' })).toBe(false);
        expect(controller.isActiveSession('session-native')).toBe(false);
    });
    it('invalidates an immediate matching stop before native work begins', async () => {
        const native = installNativeBoundary();
        const controller = createNativeVadController({ onEndpointSignal: vi.fn() });
        const starting = controller.startSession({ minSpeechMs: 120, redemptionMs: 450, sessionId: 'session-native' });
        await controller.stopSession('session-native');
        expect(await starting).toBe(false);
        expect(native.createVadDetector).not.toHaveBeenCalled();
        expect(native.capture.getSnapshot().subscriberCount).toBe(0);
    });
    it('isolates throwing observers and retires the native detector exactly once', async () => {
        const native = installNativeBoundary();
        let clock = 0;
        const fail = () => { throw new Error('broken_observer'); };
        const controller = createNativeVadController({ now: () => clock, onEndpointSignal: fail,
            onSpeechCandidateStart: fail, onSpeechCandidateFalseAlarm: fail, turnPolicy: { confirmMs: 800 } });
        await controller.startSession({ minSpeechMs: 0, redemptionMs: 0, sessionId: 'session-native' });
        await native.frame({ speechStarted: true, speechEnded: false });
        clock = 300;
        await native.frame({ speechStarted: false, speechEnded: true });
        clock = 1_000;
        await native.frame({ speechStarted: true, speechEnded: false });
        clock = 2_000;
        await native.frame({ speechStarted: false, speechEnded: true });
        await expect(controller.stopSession()).resolves.toBeUndefined();
        await controller.stopSession();
        expect(native.cancelVadDetector).toHaveBeenCalledTimes(1);
        expect(native.capture.getSnapshot().subscriberCount).toBe(0);
        expect(controller.isActiveSession('session-native')).toBe(false);
    });
    it('refuses strict retirement when the VAD microphone stop fails and retries the actual lease', async () => {
        const native = installNativeBoundary();
        const controller = createNativeVadController({ onEndpointSignal: vi.fn() });
        expect(await controller.startSession({ minSpeechMs: 0, redemptionMs: 0, sessionId: 'vad-readout' })).toBe(true);
        const stop = vi.mocked(native.nativeModule.stop);
        const originalStop = stop.getMockImplementation();
        if (!originalStop) throw new Error('Native PCM stop boundary missing');
        let refused = true;
        stop.mockImplementation(async args => {
            if (refused) throw new Error('native_vad_stop_failed');
            await originalStop(args);
        });
        try {
            await expect(controller.stopSession('vad-readout', { mode: 'read_aloud' }))
                .rejects.toThrow('native_vad_stop_failed');
            refused = false;
            await controller.stopSession('vad-readout', { mode: 'read_aloud' });
            expect(native.capture.getSnapshot()).toMatchObject({ streamId: null, subscriberCount: 0 });
            expect(getSharedVoiceAudioSessionCoordinator()?.getSnapshot().leaseCount).toBe(0);
            expect(native.cancelVadDetector).toHaveBeenCalledOnce();
        } finally {
            refused = false;
            await controller.stopSession('vad-readout');
            // A failed assertion must also retire the actual shared SDK handle.
            await native.capture.releaseUnusedCapture();
            stop.mockImplementation(originalStop);
        }
    });

    it('normalizes native timing inputs and suppresses endpoints after stop', async () => {
        const native = installNativeBoundary();
        const onEndpointSignal = vi.fn();
        const controller = createNativeVadController({ onEndpointSignal });
        expect(await controller.startSession({ minSpeechMs: 10.2, redemptionMs: 30.6, sessionId: ' session-native ' })).toBe(true);
        expect(native.createVadDetector).toHaveBeenCalledWith({ detectorId: expect.stringContaining('session-native'),
            minSpeechMs: 10, redemptionMs: 31, sampleRate: 16_000 });
        await controller.stopSession('session-native');
        native.emit();
        await native.capture.waitForDrain();
        expect(onEndpointSignal).not.toHaveBeenCalled();
        expect(native.capture.getSnapshot().subscriberCount).toBe(0);
    });
    it('settles matching stop during native startup and disposes the late capture', async () => {
        const native = installNativeBoundary();
        const gate = createDeferred<void>();
        const entered = createDeferred<void>();
        native.createVadDetector.mockImplementationOnce(() => { entered.resolve(); return gate.promise; });
        const controller = createNativeVadController({ onEndpointSignal: vi.fn() });
        const starting = controller.startSession({ minSpeechMs: 10, redemptionMs: 30, sessionId: 'session-native' });
        await entered.promise;
        expect(native.createVadDetector).toHaveBeenCalledTimes(1);
        await expect(controller.stopSession('session-native')).resolves.toBeUndefined();
        gate.resolve(undefined);
        expect(await starting).toBe(false);
        expect(native.cancelVadDetector).toHaveBeenCalledTimes(1);
        expect(native.capture.getSnapshot().subscriberCount).toBe(0);
    });
    it('preserves a pending native start when another session stops', async () => {
        const native = installNativeBoundary();
        const gate = createDeferred<void>();
        const entered = createDeferred<void>();
        native.createVadDetector.mockImplementationOnce(() => { entered.resolve(); return gate.promise; });
        const controller = createNativeVadController({ onEndpointSignal: vi.fn() });
        const starting = controller.startSession({ minSpeechMs: 10, redemptionMs: 30, sessionId: 'session-native' });
        await entered.promise;
        expect(native.createVadDetector).toHaveBeenCalledTimes(1);
        await controller.stopSession('another-session');
        gate.resolve(undefined);
        expect(await starting).toBe(true);
        expect(controller.isActiveSession('session-native')).toBe(true);
        expect(native.capture.getSnapshot().subscriberCount).toBe(1);
        await controller.stopSession();
    });
    it('keeps the replacement healthy when an older detector completes startup late', async () => {
        const native = installNativeBoundary();
        const gate = createDeferred<void>();
        const entered = createDeferred<void>();
        native.createVadDetector.mockImplementationOnce(() => { entered.resolve(); return gate.promise; });
        const controller = createNativeVadController({ onEndpointSignal: vi.fn() });
        const first = controller.startSession({ minSpeechMs: 10, redemptionMs: 30, sessionId: 'first-session' });
        await entered.promise;
        expect(native.createVadDetector).toHaveBeenCalledTimes(1);
        expect(await controller.startSession({ minSpeechMs: 10, redemptionMs: 30, sessionId: 'replacement-session' })).toBe(true);
        gate.resolve(undefined);
        expect(await first).toBe(false);
        expect(controller.isActiveSession('replacement-session')).toBe(true);
        expect(native.capture.getSnapshot().subscriberCount).toBe(1);
        await controller.stopSession();
        expect(native.cancelVadDetector).toHaveBeenCalledTimes(2);
        expect(native.capture.getSnapshot().subscriberCount).toBe(0);
    });
});
