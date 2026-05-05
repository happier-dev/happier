import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
    MachineLiveStreamStartRequestV1Schema,
    PEER_MEDIATION_RECEIPTS,
    type DirectPeerRouteKindV1,
    type MachineLiveStreamFrameV1,
    type MachineLiveStreamReceiptV1,
    type PeerFlowKindV1,
    type SignedDirectRouteGrantV1,
} from '@happier-dev/protocol';

import {
    verifyDirectRouteGrantV1,
    verifyPeerRouteNonceV1,
    type DirectRouteGrantTrustRoot,
} from '../verifyDirectRouteGrantV1';
import {
    unavailableMachineLiveStreamCaptureAdapter,
    type MachineLiveStreamCaptureAdapter,
    type MachineLiveStreamCaptureSession,
} from './captureAdapter';
import { startMachineLiveStreamFramePump } from './framePump';
import { createMachineLiveStreamSession } from './session';

export const PEER_MACHINE_LIVE_STREAM_DIRECT_START_PATH_V1 = '/peer-mediation/v1/live-stream/start' as const;

export type PeerMachineLiveStreamDirectRuntimeOptions = Readonly<{
    captureAdapter?: MachineLiveStreamCaptureAdapter;
    emitFrame?: (frame: MachineLiveStreamFrameV1) => void;
    emitReceipt?: (receipt: MachineLiveStreamReceiptV1) => void;
}>;

export type PeerMachineLiveStreamDirectExpectedBinding = Readonly<{
    accountId: string;
    machineId: string;
    flowKind: PeerFlowKindV1;
    routeKind: DirectPeerRouteKindV1;
    endpointFingerprint: string;
    accountPublicKey: string;
}>;

export type RegisterMachineLiveStreamRoutesOptions = PeerMachineLiveStreamDirectRuntimeOptions & Readonly<{
    nowMs: () => number;
    expected: PeerMachineLiveStreamDirectExpectedBinding;
    trustRoots: readonly DirectRouteGrantTrustRoot[];
    revokedGrantIds?: ReadonlySet<string>;
    revokedGrantFamilyIds?: ReadonlySet<string>;
}>;

const LiveStreamDirectStartRequestSchema = z
    .object({
        v: z.literal(1),
        streamId: z.string().min(1),
        streamFamily: z.string().min(1),
        routeKind: z.literal('loopback_direct'),
        flowKind: z.literal('live_stream'),
        endpointFingerprint: z.string().min(1),
        grant: z.unknown(),
        nonceProof: z.unknown(),
        startRequest: MachineLiveStreamStartRequestV1Schema,
    })
    .passthrough();

type LiveStreamDirectStartResponse =
    | Readonly<{
        v: 1;
        ok: true;
        receipt: typeof PEER_MEDIATION_RECEIPTS.streamStarted;
        streamId: string;
        routeKind: 'loopback_direct';
        expiresAtMs: number;
    }>
    | Readonly<{
        v: 1;
        ok: false;
        receipt: typeof PEER_MEDIATION_RECEIPTS.routeFallback;
        reasonCode: string;
    }>;

function fallback(reasonCode: string): LiveStreamDirectStartResponse {
    return {
        v: 1,
        ok: false,
        receipt: PEER_MEDIATION_RECEIPTS.routeFallback,
        reasonCode,
    };
}

function validateLiveStreamScope(input: Readonly<{
    grant: SignedDirectRouteGrantV1['payload'];
    request: z.infer<typeof LiveStreamDirectStartRequestSchema>;
}>): string | null {
    const scope = input.grant.scope;
    const startRequest = input.request.startRequest;
    if (
        scope.kind !== 'live_stream'
        || scope.streamId !== input.request.streamId
        || scope.streamId !== startRequest.streamId
        || scope.streamFamily !== input.request.streamFamily
        || scope.streamFamily !== startRequest.streamFamily
    ) {
        return 'grant_scope_mismatch';
    }
    if (startRequest.routeKind !== 'loopback_direct') return 'grant_scope_mismatch';
    if (startRequest.sourceMachineId !== input.grant.machineId) return 'grant_scope_mismatch';
    if (startRequest.maxBitrateBps > scope.maxBitrateBps) return 'cap_exceeded';
    if (startRequest.maxDurationMs > scope.maxDurationMs) return 'cap_exceeded';
    if (
        typeof scope.maxTotalBytes === 'number'
        && (startRequest.maxTotalBytes ?? scope.maxTotalBytes) > scope.maxTotalBytes
    ) {
        return 'cap_exceeded';
    }
    return null;
}

export function registerMachineLiveStreamRoutes(
    app: FastifyInstance,
    options: RegisterMachineLiveStreamRoutesOptions,
): void {
    const activeCaptureSessions = new Map<string, MachineLiveStreamCaptureSession>();
    app.addHook('onClose', async () => {
        const sessions = [...activeCaptureSessions.values()];
        activeCaptureSessions.clear();
        await Promise.all(sessions.map(async (session) => {
            await session.stop();
        }));
    });

    app.post(PEER_MACHINE_LIVE_STREAM_DIRECT_START_PATH_V1, async (request): Promise<LiveStreamDirectStartResponse> => {
        const parsed = LiveStreamDirectStartRequestSchema.safeParse(request.body);
        if (!parsed.success) return fallback('grant_invalid');
        const body = parsed.data;

        const grantVerification = verifyDirectRouteGrantV1({
            grant: body.grant,
            trustRoots: options.trustRoots,
            nowMs: options.nowMs(),
            expected: {
                accountId: options.expected.accountId,
                machineId: options.expected.machineId,
                flowKind: 'live_stream',
                routeKind: 'loopback_direct',
                endpointFingerprint: options.expected.endpointFingerprint,
            },
            revokedGrantIds: options.revokedGrantIds,
            revokedGrantFamilyIds: options.revokedGrantFamilyIds,
        });
        if (!grantVerification.valid) return fallback(grantVerification.reasonCode);

        const nonceVerification = verifyPeerRouteNonceV1({
            proof: body.nonceProof,
            accountPublicKey: options.expected.accountPublicKey,
            expected: {
                grantId: grantVerification.payload.grantId,
                routeKind: grantVerification.payload.routeKind,
                flowKind: grantVerification.payload.flowKind,
                endpointFingerprint: grantVerification.payload.endpointFingerprint,
            },
        });
        if (!nonceVerification.valid) return fallback(nonceVerification.reasonCode);

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

        const session = createMachineLiveStreamSession({
            startRequest: body.startRequest,
            routeDecision: {
                kind: 'selected',
                flowKind: 'live_stream',
                routeKind: 'loopback_direct',
                disabledReasons: [],
            },
            routeAuthorization: {
                flowKind: 'live_stream',
                routeKind: 'loopback_direct',
                streamId: body.startRequest.streamId,
                expiresAtMs: grantVerification.payload.exp,
            },
            nowMs: options.nowMs,
        });
        if (!session.ok) return fallback(session.reasonCode);

        const pump = startMachineLiveStreamFramePump({
            streamId: session.session.streamId,
            caps: body.startRequest,
            startedAtMs: session.session.startedAtMs,
            nowMs: options.nowMs,
            emitFrame: (frame) => options.emitFrame?.(frame),
            emitReceipt: (receipt) => options.emitReceipt?.(receipt),
        });
        const captureAdapter = options.captureAdapter ?? unavailableMachineLiveStreamCaptureAdapter;
        const capture = await captureAdapter.start({
            streamId: session.session.streamId,
            streamFamily: body.startRequest.streamFamily,
            sourceMachineId: body.startRequest.sourceMachineId,
            targetMachineId: body.startRequest.targetMachineId,
            caps: body.startRequest,
            startRequest: body.startRequest,
            startedAtMs: session.session.startedAtMs,
            expiresAtMs: session.session.expiresAtMs,
            nowMs: options.nowMs,
            offerFrame: pump.offerFrame,
            applyControl: pump.applyControl,
            emitReceipt: (receipt) => options.emitReceipt?.(receipt),
        });
        if (!capture.ok) return fallback(capture.reasonCode);

        const streamKey = `${session.session.streamId}:${body.startRequest.targetMachineId}`;
        const existingCapture = activeCaptureSessions.get(streamKey);
        if (existingCapture) await existingCapture.stop();
        activeCaptureSessions.set(streamKey, capture.session);

        return {
            v: 1,
            ok: true,
            receipt: PEER_MEDIATION_RECEIPTS.streamStarted,
            streamId: session.session.streamId,
            routeKind: 'loopback_direct',
            expiresAtMs: session.session.expiresAtMs,
        };
    });
}
