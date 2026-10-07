import { MachineLiveStreamCapsV1Schema, MachineLiveStreamStartRequestV1Schema, type MachineLiveStreamCapsV1, type MachineLiveStreamRelayAuthorizationV1, type MachineLiveStreamStartRequestV1 } from '@happier-dev/protocol/machines/peer/mediation/stream/v1';
import type { MachineLiveStreamCodecIdV1 } from '@happier-dev/protocol/machines/peer/mediation/stream/codecsV1';

export type MachineLiveStreamUnsignedStartRequest = Readonly<{
    v: 1;
    streamId: string;
    streamFamily: string;
    sourceId?: string;
    routeKind: 'loopback_direct' | 'server_relay';
    sourceMachineId: string;
    targetMachineId: string;
    viewerSocketId?: string;
    maxBitrateBps?: number;
    maxFramesPerSecond?: number;
    maxFrameBytes?: number;
    maxDurationMs?: number;
    maxTotalBytes?: number;
    codecId?: MachineLiveStreamCodecIdV1;
    viewerCodecs?: readonly MachineLiveStreamCodecIdV1[];
}>;

export function createBaseStartRequest(input: Readonly<{
    sourceMachineId: string;
    targetMachineId: string;
    routeKind: 'loopback_direct' | 'server_relay';
    streamId: string;
    streamFamily: string;
    sourceId?: string;
    viewerSocketId?: string | null;
    caps: MachineLiveStreamCapsV1;
    codecId?: MachineLiveStreamCodecIdV1;
    viewerCodecs?: readonly MachineLiveStreamCodecIdV1[];
}>): MachineLiveStreamUnsignedStartRequest {
    const caps = MachineLiveStreamCapsV1Schema.parse(input.caps);
    const viewerSocketId = String(input.viewerSocketId ?? '').trim();
    return {
        v: 1,
        streamId: input.streamId,
        streamFamily: input.streamFamily,
        ...(input.sourceId ? { sourceId: input.sourceId } : {}),
        routeKind: input.routeKind,
        sourceMachineId: input.sourceMachineId,
        targetMachineId: input.targetMachineId,
        ...(viewerSocketId ? { viewerSocketId } : {}),
        maxBitrateBps: caps.maxBitrateBps,
        maxFramesPerSecond: caps.maxFramesPerSecond,
        maxFrameBytes: caps.maxFrameBytes,
        maxDurationMs: caps.maxDurationMs,
        ...(caps.maxTotalBytes ? { maxTotalBytes: caps.maxTotalBytes } : {}),
        ...(input.codecId ? { codecId: input.codecId } : {}),
        ...(input.viewerCodecs ? { viewerCodecs: input.viewerCodecs } : {}),
    };
}

export function createLiveStreamStartRequest(input: Readonly<{
    baseRequest: MachineLiveStreamUnsignedStartRequest;
    authorization?: MachineLiveStreamRelayAuthorizationV1;
}>): MachineLiveStreamStartRequestV1 {
    return MachineLiveStreamStartRequestV1Schema.parse({
        ...input.baseRequest,
        // The grant owner folds requested quality with explicit Home policies.
        // Use those signed effective values; identity mismatches still fail below.
        ...(input.authorization ? {
            maxBitrateBps: input.authorization.payload.maxBitrateBps,
            maxFramesPerSecond: input.authorization.payload.maxFramesPerSecond,
            maxFrameBytes: input.authorization.payload.maxFrameBytes,
            maxDurationMs: input.authorization.payload.maxDurationMs,
            maxTotalBytes: input.authorization.payload.maxTotalBytes,
            codecId: input.authorization.payload.codecId,
            viewerCodecs: input.authorization.payload.viewerCodecs,
            authorization: input.authorization,
        } : {}),
    });
}
