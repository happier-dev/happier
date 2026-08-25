import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
    MachineLiveStreamStartRequestV1Schema,
    PEER_MACHINE_LIVE_STREAM_DIRECT_START_PATH_V2,
    PEER_MEDIATION_RECEIPTS,
    PeerMachineLiveStreamDirectStartRequestV2Schema,
    type DirectPeerRouteKindV1,
    type MachineLiveStreamFrameV1,
    type MachineLiveStreamReceiptV1,
    type PeerFlowKindV1,
    type SignedDirectRouteGrantV1,
    type SignedDirectRouteGrantV2,
} from '@happier-dev/protocol';

import type { DaemonPeerMediationDirectFlowObserver } from '../observability/events';
import {
    verifyDirectRouteGrantV1,
    verifyDirectRouteGrantV2,
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
import { createAtomicRouteGrantConsumption } from '../tunnel/grantConsumption';

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
    accountPublicKey?: string;
}>;

export type RegisterMachineLiveStreamRoutesOptions = PeerMachineLiveStreamDirectRuntimeOptions & Readonly<{
    /** Scope-bound PMS-9 observer supplied by the loopback composition root (P1-9). */
    observability?: DaemonPeerMediationDirectFlowObserver;
    nowMs: () => number;
    expected: PeerMachineLiveStreamDirectExpectedBinding;
    trustRoots: readonly DirectRouteGrantTrustRoot[];
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
    }>
    | Readonly<{
        v: 2;
        ok: true;
        receipt: typeof PEER_MEDIATION_RECEIPTS.streamStarted;
        streamId: string;
        routeKind: 'loopback_direct';
        expiresAtMs: number;
    }>
    | Readonly<{
        v: 2;
        ok: false;
        receipt: typeof PEER_MEDIATION_RECEIPTS.routeFallback;
        reasonCode: string;
    }>;

function fallback(version: 1 | 2, reasonCode: string): LiveStreamDirectStartResponse {
    const response = {
        ok: false as const,
        receipt: PEER_MEDIATION_RECEIPTS.routeFallback,
        reasonCode,
    };
    return version === 2 ? { v: 2, ...response } : { v: 1, ...response };
}

function validateLiveStreamScope(input: Readonly<{
    grant: SignedDirectRouteGrantV1['payload'] | SignedDirectRouteGrantV2['payload'];
    request: z.infer<typeof LiveStreamDirectStartRequestSchema> | z.infer<typeof PeerMachineLiveStreamDirectStartRequestV2Schema>;
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
    const grantConsumption = createAtomicRouteGrantConsumption({ activationFailurePolicy: 'release' });
    app.addHook('onClose', async () => {
        const sessions = [...activeCaptureSessions.values()];
        activeCaptureSessions.clear();
        await Promise.all(sessions.map(async (session) => {
            await session.stop();
        }));
        grantConsumption.clear();
    });

    const startDirectStream = async (requestBody: unknown, version: 1 | 2): Promise<LiveStreamDirectStartResponse> => {
        const parsed = version === 2
            ? PeerMachineLiveStreamDirectStartRequestV2Schema.safeParse(requestBody)
            : LiveStreamDirectStartRequestSchema.safeParse(requestBody);
        if (!parsed.success) return fallback(version, 'grant_invalid');
        const body = parsed.data;

        const grantVerification = body.v === 2
          ? verifyDirectRouteGrantV2({
            grant: body.grant,
            proof: body.proof,
            trustRoots: options.trustRoots,
            nowMs: options.nowMs(),
            expected: {
                accountId: options.expected.accountId,
                machineId: options.expected.machineId,
                flowKind: 'live_stream',
                routeKind: 'loopback_direct',
                endpointFingerprint: options.expected.endpointFingerprint,
            },
          })
          : verifyDirectRouteGrantV1({
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
          });
        if (!grantVerification.valid) return fallback(version, grantVerification.reasonCode);

        if (body.v === 1 && !options.expected.accountPublicKey) return fallback(version, 'nonce_invalid');
        const nonceVerification = body.v === 1 ? verifyPeerRouteNonceV1({
            proof: body.nonceProof,
            accountPublicKey: options.expected.accountPublicKey!,
            expected: {
                grantId: grantVerification.payload.grantId,
                routeKind: grantVerification.payload.routeKind,
                flowKind: grantVerification.payload.flowKind,
                endpointFingerprint: grantVerification.payload.endpointFingerprint,
            },
        }) : { valid: true as const };
        if (!nonceVerification.valid) return fallback(version, nonceVerification.reasonCode);

        if (
            body.flowKind !== 'live_stream'
            || body.routeKind !== grantVerification.payload.routeKind
            || body.endpointFingerprint !== options.expected.endpointFingerprint
        ) {
            return fallback(version, 'grant_scope_mismatch');
        }

        const scopeFailure = validateLiveStreamScope({
            grant: grantVerification.payload,
            request: body,
        });
        if (scopeFailure) return fallback(version, scopeFailure);

        const reservation = grantConsumption.reserve({
            grantId: grantVerification.payload.grantId,
            expiresAt: grantVerification.payload.exp,
            nowMs: options.nowMs(),
        });
        if (!reservation) return fallback(version, 'grant_already_consumed');

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
        if (!session.ok) {
            reservation.activationFailed();
            return fallback(version, session.reasonCode);
        }

        const pump = startMachineLiveStreamFramePump({
            streamId: session.session.streamId,
            caps: body.startRequest,
            startedAtMs: session.session.startedAtMs,
            nowMs: options.nowMs,
            emitFrame: (frame) => options.emitFrame?.(frame),
            emitReceipt: (receipt) => options.emitReceipt?.(receipt),
        });
        const captureAdapter = options.captureAdapter ?? unavailableMachineLiveStreamCaptureAdapter;
        let capture: Awaited<ReturnType<typeof captureAdapter.start>>;
        try {
            capture = await captureAdapter.start({
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
        } catch {
            reservation.activationFailed();
            return fallback(version, 'capture_start_failed');
        }
        if (!capture.ok) {
            reservation.activationFailed();
            return fallback(version, capture.reasonCode);
        }

        const streamKey = `${session.session.streamId}:${body.startRequest.targetMachineId}`;
        const existingCapture = activeCaptureSessions.get(streamKey);
        if (existingCapture) await existingCapture.stop();
        activeCaptureSessions.set(streamKey, capture.session);
        reservation.commit();

        const response = {
            ok: true,
            receipt: PEER_MEDIATION_RECEIPTS.streamStarted,
            streamId: session.session.streamId,
            routeKind: 'loopback_direct',
            expiresAtMs: session.session.expiresAtMs,
        } as const;
        return version === 2 ? { v: 2, ...response } : { v: 1, ...response };
    };

    /**
     * PMS-9 / P1-9: the direct live-stream start is a flow lifecycle boundary, so it publishes
     * `flow.ready` on admission and `flow.denied` carrying the real reason code on refusal.
     * Observing the outcome here leaves the decision logic above untouched.
     */
    const readRequestedStreamId = (requestBody: unknown): string | null => {
        const startRequest = (requestBody as { startRequest?: { streamId?: unknown } } | null | undefined)?.startRequest;
        const streamId = startRequest?.streamId;
        return typeof streamId === 'string' && streamId.trim().length > 0 ? streamId : null;
    };

    const handleStart = async (requestBody: unknown, version: 1 | 2): Promise<LiveStreamDirectStartResponse> => {
        const response = await startDirectStream(requestBody, version);
        const streamId = response.ok ? response.streamId : readRequestedStreamId(requestBody);
        if (streamId) {
            options.observability?.emit({
                flowKind: 'live_stream',
                flowId: streamId,
                kind: response.ok ? 'flow.ready' : 'flow.denied',
                ...(response.ok ? {} : { reasonCode: response.reasonCode }),
            });
        }
        return response;
    };

    app.post(PEER_MACHINE_LIVE_STREAM_DIRECT_START_PATH_V1, async (request) => await handleStart(request.body, 1));
    app.post(PEER_MACHINE_LIVE_STREAM_DIRECT_START_PATH_V2, async (request) => await handleStart(request.body, 2));
}
