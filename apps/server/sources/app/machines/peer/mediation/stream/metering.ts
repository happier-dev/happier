import { PEER_MEDIATION_RECEIPTS } from '@happier-dev/protocol/machines/peer/mediation/receipts';
import { applyMachineLiveStreamDropPolicy } from '@happier-dev/protocol/machines/peer/mediation/stream/metering';
import { type MachineLiveStreamWireFrameV1 as MachineLiveStreamFrameV1 } from '@happier-dev/protocol/machines/peer/mediation/stream/v1';
import { type MachineLiveStreamReceiptV1 } from '@happier-dev/protocol/machines/peer/mediation/stream/receipts';

export function applyMachineLiveStreamRelayBackpressure(input: Readonly<{
    streamId: string;
    routeKind: 'server_relay';
    frames: readonly MachineLiveStreamFrameV1[];
    maxWindowFrames: number;
    maxWindowBytes: number;
    reportPressure: boolean;
}>): Readonly<{
    frames: readonly MachineLiveStreamFrameV1[];
    framesDropped: number;
    bytesDropped: number;
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
        framesDropped: dropped.framesDropped,
        bytesDropped: dropped.bytesDropped,
        requiresKeyframeResync: dropped.requiresKeyframeResync,
        receipt: input.reportPressure && dropped.framesDropped > 0
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
