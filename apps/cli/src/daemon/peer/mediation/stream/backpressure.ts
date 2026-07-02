import {
    applyMachineLiveStreamDropPolicy,
    type MachineLiveStreamFrameV1,
    type MachineLiveStreamRouteKindV1,
} from '@happier-dev/protocol';

export function applyMachineLiveStreamBackpressurePolicy(input: Readonly<{
    streamId: string;
    routeKind: MachineLiveStreamRouteKindV1;
    frames: readonly MachineLiveStreamFrameV1[];
    maxWindowFrames: number;
    maxWindowBytes: number;
}>): Readonly<{
    streamId: string;
    routeKind: MachineLiveStreamRouteKindV1;
    frames: readonly MachineLiveStreamFrameV1[];
    droppedFrames: number;
    droppedBytes: number;
    requiresKeyframeResync: boolean;
}> {
    const result = applyMachineLiveStreamDropPolicy({
        frames: input.frames,
        maxWindowFrames: input.maxWindowFrames,
        maxWindowBytes: input.maxWindowBytes,
    });
    return {
        streamId: input.streamId,
        routeKind: input.routeKind,
        frames: result.frames,
        droppedFrames: result.framesDropped,
        droppedBytes: result.bytesDropped,
        requiresKeyframeResync: result.requiresKeyframeResync,
    };
}
