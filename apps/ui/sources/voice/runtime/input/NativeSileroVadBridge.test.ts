import { describe, expect, it, vi } from 'vitest';
import { createDeferred } from '@/dev/testkit';

import { resolveNativeSileroVadBridge } from './NativeSileroVadBridge';
import { createNativeVadController } from './NativeVadController';
import { createNativeVoicePcmCaptureHarness } from '@/dev/testkit/harness/nativeVoicePcmCapture';

describe('resolveNativeSileroVadBridge frame-fed VAD', () => {
    it('returns native work to the bounded capture owner and clears controller health on saturation', async () => {
        const harness = createNativeVoicePcmCaptureHarness();
        let settlePush!: (value: { speechStarted: boolean; speechEnded: boolean }) => void;
        const pushEntered = createDeferred<void>();
        const pushVadAudioFrame = vi.fn(() => new Promise<{ speechStarted: boolean; speechEnded: boolean }>((resolve) => { settlePush = resolve; pushEntered.resolve(); }));
        const cancelVadDetector = vi.fn(async () => {});
        const captureStopped = createDeferred<void>();
        const nativeStop = vi.mocked(harness.nativeModule.stop);
        const stopCapture = nativeStop.getMockImplementation();
        if (!stopCapture) throw new Error('Native capture stop boundary missing');
        nativeStop.mockImplementationOnce(async (...args) => { captureStopped.resolve(); await stopCapture(...args); });
        const bridge = await resolveNativeSileroVadBridge({ createVadDetector: vi.fn(async () => {}), pushVadAudioFrame, cancelVadDetector }, { frameSource: harness.capture });
        const onEndpointSignal = vi.fn();
        const controller = createNativeVadController({ bridge, onEndpointSignal });
        expect(await controller.startSession({ sessionId: 'bounded', minSpeechMs: 0, redemptionMs: 0 })).toBe(true);
        harness.emit();
        await pushEntered.promise;
        expect(pushVadAudioFrame).toHaveBeenCalledTimes(1);
        for (let frame = 0; frame < 8; frame += 1) harness.emit();
        expect(controller.isActiveSession('bounded')).toBe(false);
        await controller.stopSession();
        await captureStopped.promise;
        expect(cancelVadDetector).toHaveBeenCalledTimes(1);
        expect(harness.capture.getSnapshot().subscriberCount).toBe(0);
        settlePush({ speechStarted: true, speechEnded: true });
        await harness.capture.waitForDrain();
        expect(onEndpointSignal).not.toHaveBeenCalled();
        expect(pushVadAudioFrame).toHaveBeenCalledTimes(1);
    });

    it('degrades the real controller after rejected native frame work, including a startup terminal', async () => {
        const harness = createNativeVoicePcmCaptureHarness();
        const bridge = await resolveNativeSileroVadBridge({
            createVadDetector: vi.fn(async () => {}),
            pushVadAudioFrame: vi.fn(async () => { throw new Error('native_vad_failed'); }),
            cancelVadDetector: vi.fn(async () => {}),
        }, { frameSource: harness.capture });
        const controller = createNativeVadController({ bridge, onEndpointSignal: vi.fn() });
        await controller.startSession({ sessionId: 'failed', minSpeechMs: 0, redemptionMs: 0 });
        harness.emit();
        await harness.capture.waitForDrain();
        expect(controller.isActiveSession('failed')).toBe(false);
        expect(harness.capture.getSnapshot().subscriberCount).toBe(0);

        const earlyHarness = createNativeVoicePcmCaptureHarness();
        vi.mocked(earlyHarness.nativeModule.start).mockRejectedValueOnce(new Error('early_capture_terminal'));
        const earlyBridge = await resolveNativeSileroVadBridge({
            createVadDetector: vi.fn(async () => {}),
            pushVadAudioFrame: vi.fn(async () => ({ speechStarted: false, speechEnded: false })),
            cancelVadDetector: vi.fn(async () => {}),
        }, { frameSource: earlyHarness.capture });
        const earlyController = createNativeVadController({ bridge: earlyBridge, onEndpointSignal: vi.fn() });
        expect(await earlyController.startSession({ sessionId: 'early', minSpeechMs: 0, redemptionMs: 0 })).toBe(false);
        expect(earlyController.isActiveSession('early')).toBe(false);
        expect(earlyHarness.capture.getSnapshot().subscriberCount).toBe(0);
        expect(earlyHarness.coordinator.getSnapshot().leaseCount).toBe(0);
    });
    it('feeds shared capture into Sherpa without starting a second recorder', async () => {
        const harness = createNativeVoicePcmCaptureHarness();
        const pushVadAudioFrame = vi.fn()
            .mockResolvedValueOnce({ speechStarted: true, speechEnded: false })
            .mockResolvedValueOnce({ speechStarted: false, speechEnded: true });
        const createVadDetector = vi.fn(async () => {});
        const cancelVadDetector = vi.fn(async () => {});
        const onSpeechStart = vi.fn();
        const onSpeechEnd = vi.fn();
        const bridge = await resolveNativeSileroVadBridge({
            createVadDetector, pushVadAudioFrame, cancelVadDetector,
        }, { frameSource: harness.capture });
        if (!bridge) throw new Error('native VAD bridge missing');
        const session = await bridge.startSession({
            minSpeechMs: 120, redemptionMs: 400, sessionId: 'session-a', onSpeechStart, onSpeechEnd,
        });
        expect(createVadDetector).toHaveBeenCalledWith({
            detectorId: expect.any(String), minSpeechMs: 120, redemptionMs: 400, sampleRate: 16_000,
        });
        expect(harness.nativeModule.start).toHaveBeenCalledWith(expect.objectContaining({
            sampleRate: 16_000, channels: 1, frameMs: 20,
        }));
        expect(harness.coordinator.getSnapshot().configuration).toMatchObject({
            mode: 'conversation', input: true, output: true, aec: 'required',
        });
        harness.emit('AAE='); await harness.capture.waitForDrain();
        expect(onSpeechStart).toHaveBeenCalledTimes(1);
        harness.emit('AgM='); await harness.capture.waitForDrain();
        expect(onSpeechEnd).toHaveBeenCalledTimes(1);
        await session.stop(); await session.stop();
        expect(harness.capture.getSnapshot().subscriberCount).toBe(0);
        expect(harness.nativeModule.stop).toHaveBeenCalledTimes(1);
        expect(cancelVadDetector).toHaveBeenCalledTimes(1);
    });
    it('unwinds a detector when the real capture owner rejects native startup', async () => {
        const harness = createNativeVoicePcmCaptureHarness();
        vi.mocked(harness.nativeModule.start).mockRejectedValueOnce(new Error('capture_failed'));
        const cancelVadDetector = vi.fn(async () => {});
        const bridge = await resolveNativeSileroVadBridge({
            createVadDetector: vi.fn(async () => {}),
            pushVadAudioFrame: vi.fn(async () => ({ speechStarted: false, speechEnded: false })),
            cancelVadDetector,
        }, { frameSource: harness.capture });
        if (!bridge) throw new Error('native VAD bridge missing');
        await expect(bridge.startSession({
            minSpeechMs: 0, redemptionMs: 0, sessionId: 'session-b', onSpeechEnd: vi.fn(),
        })).rejects.toThrow('capture_failed');
        expect(cancelVadDetector).toHaveBeenCalledTimes(1);
        expect(harness.capture.getSnapshot().subscriberCount).toBe(0);
        expect(harness.coordinator.getSnapshot().leaseCount).toBe(0);
    });
    it('retires the detector and native subscriber on a correlated physical terminal', async () => {
        const harness = createNativeVoicePcmCaptureHarness();
        const detectorCancelled = createDeferred<void>();
        const cancelVadDetector = vi.fn(async () => { detectorCancelled.resolve(); });
        const bridge = await resolveNativeSileroVadBridge({
            createVadDetector: vi.fn(async () => {}),
            pushVadAudioFrame: vi.fn(async () => ({ speechStarted: false, speechEnded: false })),
            cancelVadDetector,
        }, { frameSource: harness.capture });
        if (!bridge) throw new Error('native VAD bridge missing');
        const session = await bridge.startSession({
            minSpeechMs: 120, redemptionMs: 400, sessionId: 'session-terminal', onSpeechEnd: vi.fn(),
        });
        const listener = vi.mocked(harness.nativeModule.addListener).mock.calls.find(([name]) => name === 'captureTerminal')?.[1];
        const generation = vi.mocked(harness.nativeModule.start).mock.calls[0]?.[0].generation;
        if (!listener || generation === undefined) throw new Error('native terminal boundary missing');
        Reflect.apply(listener, undefined, [{ streamId: 'native-stream', generation, reason: 'dead_object' }]);
        await detectorCancelled.promise;
        expect(harness.capture.getSnapshot().subscriberCount).toBe(0);
        expect(cancelVadDetector).toHaveBeenCalledTimes(1);
        await session.stop();
        expect(harness.nativeModule.stop).toHaveBeenCalledTimes(1);
        expect(cancelVadDetector).toHaveBeenCalledTimes(1);
    });
});
