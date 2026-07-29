import type { MachineLiveStreamControlSidebandV1 } from '@happier-dev/protocol';

import type {
    MachineLiveStreamCaptureAdapter,
    MachineLiveStreamControlApplyResult,
} from '../../peer/mediation/stream/captureAdapter';
import type { SimulatorStreamControlDispatch } from './runtime';

/**
 * The production bridge between the daemon simulator encoder-control RPC entry point
 * (`createSimulatorPreviewDaemonRuntime`'s `dispatchStreamControl` hook) and the live capture
 * session's `applySidebandControl` sink — the SAME sink the `server_relay` terminator drives for
 * in-band sideband control. It is NOT a parallel control path: it forwards to the exact capture
 * session that the relay terminator started.
 *
 * Wiring (all inside `startDaemonSessionControlRuntime`, the daemon startup seam):
 *  1. `wrapCaptureAdapter` is composed around each per-resource simulator capture adapter that the
 *     capture-registry reconciler registers. When the relay terminator starts capture for a stream
 *     it resolves that wrapped adapter from the shared registry; the wrapper records the started
 *     session's `applySidebandControl`, keyed by the relay `streamId`, and clears it on stop.
 *  2. `dispatch` is handed to the simulator runtime as `dispatchStreamControl`. An encoder-control
 *     RPC (`simulator.quality.set` / `simulator.keyframe.request`) resolves the recorded sink by the
 *     control's `streamId` and applies it to the live session.
 *
 * Until a live stream is active for a control's `streamId`, `dispatch` reports
 * `live_stream_start_required` (an honest "no live session yet"), never the
 * `simulator_stream_control_dispatch_unavailable` reason that the runtime emits when the hook is
 * absent entirely.
 */
export type SimulatorStreamControlBridge = Readonly<{
    dispatch: SimulatorStreamControlDispatch;
    wrapCaptureAdapter: (adapter: MachineLiveStreamCaptureAdapter) => MachineLiveStreamCaptureAdapter;
}>;

type SidebandControlSink = (control: MachineLiveStreamControlSidebandV1) => MachineLiveStreamControlApplyResult;

export function createSimulatorStreamControlBridge(): SimulatorStreamControlBridge {
    const sinksByStreamId = new Map<string, SidebandControlSink>();

    const dispatch: SimulatorStreamControlDispatch = (control) => {
        const sink = sinksByStreamId.get(control.streamId);
        if (!sink) {
            return { ok: false, reasonCode: 'live_stream_start_required' };
        }
        return sink(control);
    };

    const wrapCaptureAdapter = (
        adapter: MachineLiveStreamCaptureAdapter,
    ): MachineLiveStreamCaptureAdapter => ({
        start: async (input) => {
            const result = await adapter.start(input);
            if (!result.ok) {
                return result;
            }
            const sideband = result.session.applySidebandControl;
            if (!sideband) {
                // No live sideband sink on this session (e.g. a producer without encoder controls):
                // leave the stream unregistered so `dispatch` stays honest about the missing sink.
                return result;
            }
            sinksByStreamId.set(input.streamId, sideband);
            return {
                ok: true,
                session: {
                    ...result.session,
                    stop: async () => {
                        sinksByStreamId.delete(input.streamId);
                        await result.session.stop();
                    },
                },
            };
        },
    });

    return { dispatch, wrapCaptureAdapter };
}
