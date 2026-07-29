import type { MachineLiveStreamControlSidebandV1 } from '@happier-dev/protocol';

export type LiveStreamAdaptationState = Readonly<{
    degraded: boolean;
    needsKeyframe: boolean;
    lastQualityRequestAtMs?: number;
    lastKeyframeRequestAtMs?: number;
}>;

export type LiveStreamAdaptationMetrics = Readonly<{
    decodeLagMs: number;
    droppedFrames: number;
    bufferedBytes: number;
    needsKeyframe?: boolean;
}>;

export type LiveStreamAdaptationLimits = Readonly<{
    minRequestIntervalMs: number;
    maxBufferedBytes: number;
    maxDecodeLagMs: number;
    maxDroppedFrames: number;
    degradedQuality?: Readonly<{
        maxFramesPerSecond?: number;
        maxBitrateBps?: number;
        maxWidth?: number;
        maxHeight?: number;
    }>;
}>;

export type LiveStreamAdaptationDecision = Readonly<{
    state: LiveStreamAdaptationState;
    controls: readonly MachineLiveStreamControlSidebandV1[];
    reasonCode?: 'adaptation_rate_limited' | 'viewer_degraded' | 'keyframe_recovery';
}>;

export const initialLiveStreamAdaptationState: LiveStreamAdaptationState = {
    degraded: false,
    needsKeyframe: false,
};

function isRateLimited(lastRequestAtMs: number | undefined, nowMs: number, minIntervalMs: number): boolean {
    return typeof lastRequestAtMs === 'number' && nowMs - lastRequestAtMs < Math.max(0, minIntervalMs);
}

function isSlowViewer(metrics: LiveStreamAdaptationMetrics, limits: LiveStreamAdaptationLimits): boolean {
    return metrics.bufferedBytes > limits.maxBufferedBytes
        || metrics.decodeLagMs > limits.maxDecodeLagMs
        || metrics.droppedFrames > limits.maxDroppedFrames;
}

function positiveInteger(value: number | undefined): number | undefined {
    if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
    const integer = Math.floor(value);
    return integer > 0 ? integer : undefined;
}

export function resolveLiveStreamAdaptationDecision(input: Readonly<{
    state: LiveStreamAdaptationState;
    streamId: string;
    sourceId: string;
    eventId: string;
    nowMs: number;
    metrics: LiveStreamAdaptationMetrics;
    limits: LiveStreamAdaptationLimits;
}>): LiveStreamAdaptationDecision {
    const minIntervalMs = Math.max(0, Math.floor(input.limits.minRequestIntervalMs));

    if (input.metrics.needsKeyframe === true) {
        if (isRateLimited(input.state.lastKeyframeRequestAtMs, input.nowMs, minIntervalMs)) {
            return {
                state: input.state,
                controls: [],
                reasonCode: 'adaptation_rate_limited',
            };
        }

        return {
            state: {
                ...input.state,
                needsKeyframe: true,
                lastKeyframeRequestAtMs: input.nowMs,
            },
            controls: [{
                v: 1,
                streamId: input.streamId,
                sourceId: input.sourceId,
                eventId: input.eventId,
                kind: 'request_keyframe',
            }],
            reasonCode: 'keyframe_recovery',
        };
    }

    if (!isSlowViewer(input.metrics, input.limits)) {
        return {
            state: input.state.degraded ? { ...input.state, degraded: false } : input.state,
            controls: [],
        };
    }

    if (isRateLimited(input.state.lastQualityRequestAtMs, input.nowMs, minIntervalMs)) {
        return {
            state: input.state,
            controls: [],
            reasonCode: 'adaptation_rate_limited',
        };
    }

    if (input.state.degraded) {
        return {
            state: input.state,
            controls: [],
            reasonCode: 'viewer_degraded',
        };
    }

    const degradedQuality = input.limits.degradedQuality ?? {
        maxFramesPerSecond: 15,
        maxBitrateBps: 1_500_000,
    };
    const maxFramesPerSecond = positiveInteger(degradedQuality.maxFramesPerSecond);
    const maxBitrateBps = positiveInteger(degradedQuality.maxBitrateBps);
    const maxWidth = positiveInteger(degradedQuality.maxWidth);
    const maxHeight = positiveInteger(degradedQuality.maxHeight);

    return {
        state: {
            ...input.state,
            degraded: true,
            lastQualityRequestAtMs: input.nowMs,
        },
        controls: [{
            v: 1,
            streamId: input.streamId,
            sourceId: input.sourceId,
            eventId: input.eventId,
            kind: 'set_quality',
            ...(maxFramesPerSecond ? { maxFramesPerSecond } : {}),
            ...(maxBitrateBps ? { maxBitrateBps } : {}),
            ...(maxWidth ? { maxWidth } : {}),
            ...(maxHeight ? { maxHeight } : {}),
        }],
        reasonCode: 'viewer_degraded',
    };
}
