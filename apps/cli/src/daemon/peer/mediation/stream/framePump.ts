import type {
    MachineLiveStreamCapsV1,
    MachineLiveStreamControlV1,
    MachineLiveStreamFrameV1,
    MachineLiveStreamReceiptV1,
    MachineLiveStreamRouteKindV1,
} from '@happier-dev/protocol';
import {
    createMachineLiveStreamMeter,
    getMachineLiveStreamPayloadDecodedByteLength,
    MachineLiveStreamControlV1Schema,
    MachineLiveStreamFrameV1Schema,
    PEER_MEDIATION_RECEIPTS,
} from '@happier-dev/protocol';

type FramePumpReasonCode =
    | 'invalid_control'
    | 'invalid_frame'
    | 'stream_mismatch'
    | 'non_monotonic_sequence'
    | 'backpressure_window_exhausted'
    | 'max_frame_bytes_exceeded'
    | 'max_duration_ms_exceeded'
    | 'max_total_bytes_exceeded'
    | 'max_frames_per_second_exceeded'
    | 'max_bitrate_bps_exceeded';

function createReceipt(input: Readonly<{
    id: typeof PEER_MEDIATION_RECEIPTS.streamPaused | typeof PEER_MEDIATION_RECEIPTS.streamBandwidthCapped;
    streamId: string;
    routeKind: MachineLiveStreamRouteKindV1;
    reasonCode: string;
    caps: MachineLiveStreamCapsV1;
    bytesSent?: number;
    framesSent?: number;
}>): MachineLiveStreamReceiptV1 {
    return {
        v: 1,
        id: input.id,
        streamId: input.streamId,
        routeKind: input.routeKind,
        flowKind: 'live_stream',
        reasonCode: input.reasonCode,
        maxBitrateBps: input.caps.maxBitrateBps,
        maxFramesPerSecond: input.caps.maxFramesPerSecond,
        maxFrameBytes: input.caps.maxFrameBytes,
        maxDurationMs: input.caps.maxDurationMs,
        ...(input.caps.maxTotalBytes ? { maxTotalBytes: input.caps.maxTotalBytes } : {}),
        ...(typeof input.bytesSent === 'number' ? { bytesSent: input.bytesSent } : {}),
        ...(typeof input.framesSent === 'number' ? { framesSent: input.framesSent } : {}),
    };
}

export function startMachineLiveStreamFramePump(_input: Readonly<{
    streamId: string;
    routeKind?: MachineLiveStreamRouteKindV1;
    caps: MachineLiveStreamCapsV1;
    startedAtMs: number;
    nowMs: () => number;
    emitFrame: (frame: MachineLiveStreamFrameV1) => void;
    emitReceipt: (receipt: MachineLiveStreamReceiptV1) => void;
}>): Readonly<{
    applyControl: (
        control: MachineLiveStreamControlV1,
    ) => Readonly<{ ok: true } | { ok: false; reasonCode: 'invalid_control' | 'stale_ack' }>;
    offerFrame: (frame: MachineLiveStreamFrameV1) => Readonly<{ ok: true } | { ok: false; reasonCode: FramePumpReasonCode }>;
}> {
    let windowFrames = Number.POSITIVE_INFINITY;
    let windowBytes = Number.POSITIVE_INFINITY;
    let nextSequence = 1;
    const meter = createMachineLiveStreamMeter({
        caps: _input.caps,
        startedAtMs: _input.startedAtMs,
    });
    const routeKind = _input.routeKind ?? 'loopback_direct';

    return {
        applyControl: (rawControl) => {
            const parsed = MachineLiveStreamControlV1Schema.safeParse(rawControl);
            if (!parsed.success) return { ok: false, reasonCode: 'invalid_control' };
            const control = parsed.data;
            if (control.streamId !== _input.streamId) return { ok: false, reasonCode: 'invalid_control' };
            if (control.kind === 'ack') {
                if (control.nextSequence < nextSequence) return { ok: false, reasonCode: 'stale_ack' };
                nextSequence = control.nextSequence;
                windowFrames = control.windowFrames ?? Number.POSITIVE_INFINITY;
                windowBytes = control.windowBytes ?? Number.POSITIVE_INFINITY;
            }
            return { ok: true };
        },
        offerFrame: (rawFrame) => {
            const parsed = MachineLiveStreamFrameV1Schema.safeParse(rawFrame);
            if (!parsed.success) return { ok: false, reasonCode: 'invalid_frame' };
            const frame = parsed.data;
            if (frame.streamId !== _input.streamId) return { ok: false, reasonCode: 'stream_mismatch' };
            if (frame.sequence !== nextSequence) {
                _input.emitReceipt(createReceipt({
                    id: PEER_MEDIATION_RECEIPTS.streamPaused,
                    streamId: _input.streamId,
                    routeKind,
                    reasonCode: 'non_monotonic_sequence',
                    caps: _input.caps,
                }));
                return { ok: false, reasonCode: 'non_monotonic_sequence' };
            }

            const metered = meter.recordFrame(frame, _input.nowMs());
            if (!metered.ok) {
                _input.emitReceipt(createReceipt({
                    id: PEER_MEDIATION_RECEIPTS.streamBandwidthCapped,
                    streamId: _input.streamId,
                    routeKind,
                    reasonCode: metered.reasonCode,
                    caps: _input.caps,
                    bytesSent: metered.metering.bytesSent,
                    framesSent: metered.metering.framesSent,
                }));
                return { ok: false, reasonCode: metered.reasonCode };
            }

            const frameBytes = getMachineLiveStreamPayloadDecodedByteLength(frame.payloadBase64);
            if (frame.sequence < nextSequence || windowFrames <= 0 || windowBytes < frameBytes) {
                _input.emitReceipt(createReceipt({
                    id: PEER_MEDIATION_RECEIPTS.streamPaused,
                    streamId: _input.streamId,
                    routeKind,
                    reasonCode: 'backpressure_window_exhausted',
                    caps: _input.caps,
                    bytesSent: metered.metering.bytesSent,
                    framesSent: metered.metering.framesSent,
                }));
                return { ok: false, reasonCode: 'backpressure_window_exhausted' };
            }

            _input.emitFrame(frame);
            nextSequence = frame.sequence + 1;
            windowFrames = Number.isFinite(windowFrames) ? Math.max(0, windowFrames - 1) : windowFrames;
            windowBytes = Number.isFinite(windowBytes) ? Math.max(0, windowBytes - frameBytes) : windowBytes;
            return { ok: true };
        },
    };
}
