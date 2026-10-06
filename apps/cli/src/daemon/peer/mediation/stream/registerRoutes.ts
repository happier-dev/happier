import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PEER_MACHINE_LIVE_STREAM_DIRECT_START_PATH_V2, PeerMachineLiveStreamDirectStartRequestV2Schema } from '@happier-dev/protocol/machines/peer/mediation/stream/directV2';
import { PEER_MEDIATION_RECEIPTS } from '@happier-dev/protocol/machines/peer/mediation/receipts';
import type { DirectPeerRouteKindV1, PeerFlowKindV1, SignedDirectRouteGrantV2 } from '@happier-dev/protocol';

import type { DaemonPeerMediationDirectFlowObserver } from '../observability/events';
import {
    verifyDirectRouteGrantV2,
    type DirectRouteGrantTrustRoot,
} from '../verifyDirectRouteGrant';
import type { MachineLiveStreamCaptureAdapter } from './captureAdapter';

export type PeerMachineLiveStreamDirectRuntimeOptions = Readonly<{
    captureAdapter?: MachineLiveStreamCaptureAdapter;
}>;

export type PeerMachineLiveStreamDirectExpectedBinding = Readonly<{
    accountId: string;
    machineId: string;
    flowKind: PeerFlowKindV1;
    routeKind: DirectPeerRouteKindV1;
    endpointFingerprint: string;
}>;

export type RegisterMachineLiveStreamRoutesOptions = PeerMachineLiveStreamDirectRuntimeOptions & Readonly<{
    /** Scope-bound PMS-9 observer supplied by the loopback composition root (P1-9). */
    observability?: DaemonPeerMediationDirectFlowObserver;
    nowMs: () => number;
    expected: PeerMachineLiveStreamDirectExpectedBinding;
    trustRoots: readonly DirectRouteGrantTrustRoot[];
    resolveTrustRoots?: () => readonly DirectRouteGrantTrustRoot[];
}>;

type LiveStreamDirectStartResponse = Readonly<{
    v: 2;
    ok: false;
    receipt: typeof PEER_MEDIATION_RECEIPTS.routeFallback;
    reasonCode: string;
}>;

function fallback(reasonCode: string): LiveStreamDirectStartResponse {
    return { v: 2, ok: false, receipt: PEER_MEDIATION_RECEIPTS.routeFallback, reasonCode };
}

function validateLiveStreamScope(input: Readonly<{
    grant: SignedDirectRouteGrantV2['payload'];
    request: z.infer<typeof PeerMachineLiveStreamDirectStartRequestV2Schema>;
}>): string | null {
    const scope = input.grant.scope;
    const startRequest = input.request.startRequest;
    if (
        scope.kind !== 'live_stream'
        || scope.streamId !== input.request.streamId
        || scope.streamId !== startRequest.streamId
        || scope.streamFamily !== input.request.streamFamily
        || scope.streamFamily !== startRequest.streamFamily
        || scope.sourceId !== startRequest.sourceId
    ) {
        return 'grant_scope_mismatch';
    }
    if (startRequest.routeKind !== 'loopback_direct') return 'grant_scope_mismatch';
    if (startRequest.sourceMachineId !== input.grant.machineId) return 'grant_scope_mismatch';
    if (
        typeof scope.maxBitrateBps === 'number'
        && typeof startRequest.maxBitrateBps === 'number'
        && startRequest.maxBitrateBps > scope.maxBitrateBps
    ) return 'cap_exceeded';
    if (
        typeof scope.maxDurationMs === 'number'
        && typeof startRequest.maxDurationMs === 'number'
        && startRequest.maxDurationMs > scope.maxDurationMs
    ) return 'cap_exceeded';
    if (
        typeof scope.maxTotalBytes === 'number'
        && typeof startRequest.maxTotalBytes === 'number'
        && startRequest.maxTotalBytes > scope.maxTotalBytes
    ) {
        return 'cap_exceeded';
    }
    return null;
}

export function registerMachineLiveStreamRoutes(
    app: FastifyInstance,
    options: RegisterMachineLiveStreamRoutesOptions,
): void {
    const startDirectStream = async (requestBody: unknown): Promise<LiveStreamDirectStartResponse> => {
        const parsed = PeerMachineLiveStreamDirectStartRequestV2Schema.safeParse(requestBody);
        if (!parsed.success) return fallback('grant_invalid');
        const body = parsed.data;

        const grantVerification = verifyDirectRouteGrantV2({
            grant: body.grant,
            proof: body.proof,
            trustRoots: options.resolveTrustRoots?.() ?? options.trustRoots,
            nowMs: options.nowMs(),
            expected: {
                accountId: options.expected.accountId,
                machineId: options.expected.machineId,
                flowKind: 'live_stream',
                routeKind: 'loopback_direct',
                endpointFingerprint: options.expected.endpointFingerprint,
            },
        });
        if (!grantVerification.valid) return fallback(grantVerification.reasonCode);

        if (
            body.flowKind !== 'live_stream'
            || body.routeKind !== grantVerification.payload.routeKind
            || body.endpointFingerprint !== options.expected.endpointFingerprint
        ) {
            return fallback('grant_scope_mismatch');
        }

        const scopeFailure = validateLiveStreamScope({
            grant: grantVerification.payload,
            request: body,
        });
        if (scopeFailure) return fallback(scopeFailure);

        // A start endpoint alone cannot deliver frames or own viewer control/ACK/stop.
        // Refuse before capture or grant consumption so the caller can use the relay.
        return fallback('direct_stream_channel_unavailable');
    };

    /**
     * PMS-9 / P1-9: the direct live-stream start is a flow lifecycle boundary, so it publishes
     * `flow.denied` carrying the real reason code on refusal.
     */
    const readRequestedStreamId = (requestBody: unknown): string | null => {
        const startRequest = (requestBody as { startRequest?: { streamId?: unknown } } | null | undefined)?.startRequest;
        const streamId = startRequest?.streamId;
        return typeof streamId === 'string' && streamId.trim().length > 0 ? streamId : null;
    };

    const handleStart = async (requestBody: unknown): Promise<LiveStreamDirectStartResponse> => {
        const response = await startDirectStream(requestBody);
        const streamId = readRequestedStreamId(requestBody);
        if (streamId) {
            options.observability?.emit({
                flowKind: 'live_stream',
                flowId: streamId,
                kind: 'flow.denied',
                reasonCode: response.reasonCode,
            });
        }
        return response;
    };

    app.post(PEER_MACHINE_LIVE_STREAM_DIRECT_START_PATH_V2, async (request) => await handleStart(request.body));
}
