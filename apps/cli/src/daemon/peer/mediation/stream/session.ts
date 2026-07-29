import {
    MachineLiveStreamStartRequestV1Schema,
    PEER_MEDIATION_RECEIPTS,
    type MachineLiveStreamReceiptV1,
    type MachineLiveStreamStartRequestV1,
} from '@happier-dev/protocol';
import type { LiveStreamRouteDecision } from '@happier-dev/peer-mediation';

export type MachineLiveStreamRouteAuthorization = Readonly<{
    flowKind: 'live_stream';
    routeKind: 'loopback_direct' | 'server_relay';
    streamId: string;
    expiresAtMs: number;
}>;

export function createMachineLiveStreamSession(_input: Readonly<{
    startRequest: MachineLiveStreamStartRequestV1;
    routeDecision: LiveStreamRouteDecision;
    routeAuthorization?: MachineLiveStreamRouteAuthorization;
    nowMs: () => number;
}>): Readonly<
    | { ok: false; reasonCode: 'invalid_start_request' | 'route_not_authorized' }
    | {
        ok: true;
        session: Readonly<{
            streamId: string;
            routeKind: 'loopback_direct' | 'server_relay';
            targetMachineId: string;
            startedAtMs: number;
            expiresAtMs: number;
            receipt: MachineLiveStreamReceiptV1;
        }>;
    }
> {
    const input = _input;
    const parsedStart = MachineLiveStreamStartRequestV1Schema.safeParse(input.startRequest);
    if (!parsedStart.success) return { ok: false, reasonCode: 'invalid_start_request' };
    if (input.routeDecision.kind !== 'selected') return { ok: false, reasonCode: 'route_not_authorized' };

    const authorization = input.routeAuthorization;
    const startRequest = parsedStart.data;
    if (
        !authorization
        || input.routeDecision.routeKind !== startRequest.routeKind
        || authorization.flowKind !== 'live_stream'
        || authorization.streamId !== startRequest.streamId
        || authorization.routeKind !== startRequest.routeKind
        || authorization.expiresAtMs <= input.nowMs()
    ) {
        return { ok: false, reasonCode: 'route_not_authorized' };
    }

    return {
        ok: true,
        session: {
            streamId: startRequest.streamId,
            routeKind: startRequest.routeKind,
            targetMachineId: startRequest.targetMachineId,
            startedAtMs: input.nowMs(),
            expiresAtMs: input.nowMs() + startRequest.maxDurationMs,
            receipt: {
                v: 1,
                id: PEER_MEDIATION_RECEIPTS.streamStarted,
                streamId: startRequest.streamId,
                routeKind: startRequest.routeKind,
                flowKind: 'live_stream',
                maxBitrateBps: startRequest.maxBitrateBps,
                maxFramesPerSecond: startRequest.maxFramesPerSecond,
                maxFrameBytes: startRequest.maxFrameBytes,
                maxDurationMs: startRequest.maxDurationMs,
                ...(startRequest.maxTotalBytes ? { maxTotalBytes: startRequest.maxTotalBytes } : {}),
            },
        },
    };
}
