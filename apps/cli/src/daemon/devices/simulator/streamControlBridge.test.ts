import { describe, expect, it, vi } from 'vitest';

import type { MachineLiveStreamControlSidebandV1 } from '@happier-dev/protocol';

import type {
    MachineLiveStreamCaptureAdapter,
    MachineLiveStreamCaptureStartInput,
} from '../../peer/mediation/stream/captureAdapter';
import { createSimulatorPreviewDaemonRuntime } from './runtime';
import { createSimulatorStreamControlBridge } from './streamControlBridge';
import type { SimulatorDeviceResourceV1 } from '@happier-dev/protocol';

function startInput(streamId: string): MachineLiveStreamCaptureStartInput {
    return {
        streamId,
        streamFamily: 'simulator',
        sourceMachineId: 'machine_1',
        targetMachineId: 'machine_1',
        caps: {} as MachineLiveStreamCaptureStartInput['caps'],
        startRequest: {} as MachineLiveStreamCaptureStartInput['startRequest'],
        startedAtMs: 0,
        expiresAtMs: 0,
        nowMs: () => 0,
        offerFrame: () => ({ ok: true }),
        applyControl: () => ({ ok: true }),
        emitReceipt: () => {},
    };
}

const keyframeControl: MachineLiveStreamControlSidebandV1 = {
    v: 1,
    kind: 'request_keyframe',
    streamId: 'stream_1',
    sourceId: 'source_android',
    eventId: 'k1',
};

describe('simulator stream-control bridge', () => {
    it('reports live_stream_start_required (never dispatch_unavailable) before a stream is active', () => {
        const bridge = createSimulatorStreamControlBridge();
        expect(bridge.dispatch(keyframeControl)).toEqual({ ok: false, reasonCode: 'live_stream_start_required' });
    });

    it('forwards a dispatched control to the started capture session applySidebandControl sink', async () => {
        const bridge = createSimulatorStreamControlBridge();
        const applySidebandControl = vi.fn(() => ({ ok: true as const }));
        const baseAdapter: MachineLiveStreamCaptureAdapter = {
            start: async () => ({ ok: true, session: { stop: vi.fn(), applySidebandControl } }),
        };
        const wrapped = bridge.wrapCaptureAdapter(baseAdapter);

        const started = await wrapped.start(startInput('stream_1'));
        expect(started.ok).toBe(true);

        expect(bridge.dispatch(keyframeControl)).toEqual({ ok: true });
        expect(applySidebandControl).toHaveBeenCalledWith(keyframeControl);
    });

    it('clears the sink on session stop so a later dispatch is live_stream_start_required again', async () => {
        const bridge = createSimulatorStreamControlBridge();
        const applySidebandControl = vi.fn(() => ({ ok: true as const }));
        const wrapped = bridge.wrapCaptureAdapter({
            start: async () => ({ ok: true, session: { stop: vi.fn(), applySidebandControl } }),
        });

        const started = await wrapped.start(startInput('stream_1'));
        if (!started.ok) throw new Error('expected start to succeed');
        await started.session.stop();

        expect(bridge.dispatch(keyframeControl)).toEqual({ ok: false, reasonCode: 'live_stream_start_required' });
    });

    it('targets the sink by the control streamId across concurrent streams', async () => {
        const bridge = createSimulatorStreamControlBridge();
        const sinkA = vi.fn(() => ({ ok: true as const }));
        const sinkB = vi.fn(() => ({ ok: false as const, reasonCode: 'rejected_b' }));
        const wrapped = bridge.wrapCaptureAdapter({
            start: async (input) => ({
                ok: true,
                session: { stop: vi.fn(), applySidebandControl: input.streamId === 'stream_a' ? sinkA : sinkB },
            }),
        });
        await wrapped.start(startInput('stream_a'));
        await wrapped.start(startInput('stream_b'));

        expect(bridge.dispatch({ ...keyframeControl, streamId: 'stream_a' })).toEqual({ ok: true });
        expect(bridge.dispatch({ ...keyframeControl, streamId: 'stream_b' })).toEqual({ ok: false, reasonCode: 'rejected_b' });
        expect(sinkA).toHaveBeenCalledOnce();
        expect(sinkB).toHaveBeenCalledOnce();
    });

    it('prod-assembly: an advertised keyframe RPC is NOT *_dispatch_unavailable once the runtime is wired with the bridge', async () => {
        const bridge = createSimulatorStreamControlBridge();
        const applySidebandControl = vi.fn(() => ({ ok: true as const }));
        // Mirror the production assembly: a capture session for the live stream is registered through
        // the wrapped capture adapter, then the runtime dispatches the encoder RPC over the bridge.
        const wrapped = bridge.wrapCaptureAdapter({
            start: async () => ({ ok: true, session: { stop: vi.fn(), applySidebandControl } }),
        });
        await wrapped.start(startInput('stream_1'));

        const androidResource: SimulatorDeviceResourceV1 = {
            v: 1,
            simulatorId: 'sim_android',
            platform: 'android',
            deviceId: 'emulator-5554',
            displayName: 'Pixel 9',
            capture: {
                status: 'available',
                sourceId: 'source_android',
                supportedCodecs: ['h264.avcc'],
                inputMode: 'exclusive',
                supportedInputKinds: ['tap'],
                streamControls: {
                    requestKeyframe: true,
                    snapshot: true,
                    setQuality: true,
                    setFps: false,
                    setScale: false,
                },
            },
        };
        const runtime = createSimulatorPreviewDaemonRuntime({
            machineId: 'machine_1',
            now: () => 1_000,
            resources: [androidResource],
            // The hook supplied at daemon startup. A non-null hook is the whole point of A1.
            dispatchStreamControl: bridge.dispatch,
        });

        const result = await runtime.routes.dispatchAction({
            type: 'simulator.keyframe.request',
            simulatorId: 'sim_android',
            streamId: 'stream_1',
            sourceId: 'source_android',
            control: keyframeControl,
        });

        expect(result.status).toBe('accepted');
        expect((result as { reasonCode?: string }).reasonCode).not.toBe('simulator_stream_control_dispatch_unavailable');
        expect(applySidebandControl).toHaveBeenCalledWith(keyframeControl);
    });
});
