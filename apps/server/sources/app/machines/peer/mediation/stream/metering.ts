import {
    PEER_MEDIATION_RECEIPTS,
    applyMachineLiveStreamDropPolicy,
    type MachineLiveStreamFrameV1,
    type MachineLiveStreamReceiptV1,
} from '@happier-dev/protocol';

export function applyMachineLiveStreamRelayBackpressure(input: Readonly<{
    streamId: string;
    routeKind: 'server_relay';
    frames: readonly MachineLiveStreamFrameV1[];
    maxWindowFrames: number;
    maxWindowBytes: number;
    capIntervalExceeded: boolean;
}>): Readonly<{
    frames: readonly MachineLiveStreamFrameV1[];
    receipt: MachineLiveStreamReceiptV1 | null;
    requiresKeyframeResync: boolean;
}> {
    const dropped = applyMachineLiveStreamDropPolicy({
        frames: input.frames,
        maxWindowFrames: input.maxWindowFrames,
        maxWindowBytes: input.maxWindowBytes,
    });

    return {
        frames: dropped.frames,
        requiresKeyframeResync: dropped.requiresKeyframeResync,
        receipt: input.capIntervalExceeded && dropped.framesDropped > 0
            ? {
                v: 1,
                id: PEER_MEDIATION_RECEIPTS.streamBandwidthCapped,
                streamId: input.streamId,
                routeKind: input.routeKind,
                flowKind: 'live_stream',
                reasonCode: 'relay_window_pressure',
                bytesDropped: dropped.bytesDropped,
                framesDropped: dropped.framesDropped,
            }
            : null,
    };
}
