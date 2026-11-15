import { MACHINE_LIVE_STREAM_SOCKET_EVENT, MachineLiveStreamRelayEnvelopeV1Schema, createMachineLiveStreamRelayAuthorizationSigningInputV1, type MachineLiveStreamControlV1, type MachineLiveStreamWireFrameV1 as MachineLiveStreamFrameV1, type MachineLiveStreamRelayCaps, type MachineLiveStreamWireEnvelopeV1, type MachineLiveStreamStartRequestV1 } from '@happier-dev/protocol/machines/peer/mediation/stream/v1';
import { MachineLiveStreamReceiptV1Schema, isMachineLiveStreamTerminalReceiptV1, type MachineLiveStreamReceiptV1 } from '@happier-dev/protocol/machines/peer/mediation/stream/receipts';
import { PEER_MEDIATION_RECEIPTS } from '@happier-dev/protocol/machines/peer/mediation/receipts';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import type { Server, Socket } from 'socket.io';
import tweetnacl from 'tweetnacl';
import { resolveSocketMaxHttpBufferSizeFromEnv } from './transportBudget';
import { getMachineInstallationSocketRoom } from '../socketRooms';
import { resolveMachineAdmission } from '@/app/machines/machineAccess';
import { eventRouter } from '@/app/events/eventRouter';
import { db } from '@/storage/db';
import { resolveSessionAccessForOperation } from '@/app/session/access/sessionAccess';
import type { SessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication';
import { machineLiveStreamControlRequiresInputLeaseV1 } from '@happier-dev/protocol/machines/peer/mediation/stream/controlV1';

import { resolveMachineLiveStreamRelayCaps } from '../../machines/peer/mediation/stream/relayCaps';
import { applyMachineLiveStreamRelayBackpressure } from '../../machines/peer/mediation/stream/metering';
import { createMachineLiveStreamMeter } from '@happier-dev/protocol/machines/peer/mediation/stream/metering';
import type { PeerMediationViewerSocketOwnershipVerifier, PeerMediationViewerSessionAuthenticationReader } from './viewerSocketOwnership';
import {
    createPeerMediationFlowEvent,
    type PeerMediationObservabilityEmitter,
} from './peer/mediation/observability/events';

type MachineLiveStreamKey = string;
type MachineLiveStreamRelayEnvelopeV1 = Omit<MachineLiveStreamWireEnvelopeV1, 'message'> & {
    message: Exclude<MachineLiveStreamWireEnvelopeV1['message'], { kind: 'receipt' }>
        | { kind: 'receipt'; receipt: MachineLiveStreamReceiptV1 };
};

type MachineLiveStreamRelayState = {
    userId: string;
    encryptionMode: 'plain' | 'e2ee';
    streamId: string;
    sourceMachineId: string;
    targetMachineId: string;
    sourceMachineInstallationId: string;
    targetMachineInstallationId: string;
    // Per-tab viewer target (C3). When set, the watcher is a user-scoped browser socket and
    // relayed frames/controls are delivered directly to that socket (`io.to(viewerSocketId)`)
    // rather than the `machine:<targetMachineId>:<userId>` room the viewer never joins. Empty
    // string preserves the legacy machine→machine delivery path.
    viewerSocketId: string;
    startRequest: MachineLiveStreamStartRequestV1;
    caps: MachineLiveStreamRelayCaps;
    maxWindowFrames: number;
    maxWindowBytes: number;
    startedAtMs: number;
    expiresAtMs: number;
    bytesRelayed: number;
    bytesDropped: number;
    framesRelayed: number;
    framesDropped: number;
    bandwidthPressure: boolean;
    meter: ReturnType<typeof createMachineLiveStreamMeter>;
    queuedFrames: MachineLiveStreamFrameV1[];
    availableWindowFrames: number;
    availableWindowBytes: number;
    nextSequenceToRelay: number;
    lastAckNextSequence: number;
    awaitingKeyframe: boolean;
    retireAfterSessionAccessChange?: () => void | Promise<void>;
};

type RelayIo = Pick<Server, 'to'> | Readonly<{
    to: (room: string) => Readonly<{ emit: (event: string, payload: unknown) => void }>;
}>;

type RelayAuthorizationTrustRoot = Readonly<{
    keyId: string;
    publicKeyBase64Url: string;
}>;

const streamStateByKey = new Map<MachineLiveStreamKey, MachineLiveStreamRelayState>();
const pendingStartAdmissionsByKey = new Map<MachineLiveStreamKey, Promise<void>>();
const VIEWER_SOCKET_REQUIRED_REASON = 'viewer_socket_required';

/** The existing committed Session transition retires open-ended Browser access. */
export function retireSessionBrowserLiveStreamsAfterAccessChange(sessionId: string): void {
    for (const state of [...streamStateByKey.values()]) {
        const payload = state.startRequest.authorization?.payload;
        if (payload?.v === 2 && payload.sessionBrowserAccess?.sessionId === sessionId) {
            void state.retireAfterSessionAccessChange?.();
        }
    }
}

function buildStreamKey(input: Readonly<{
    sourceMachineId: string;
    targetMachineId: string;
    streamId: string;
}>): MachineLiveStreamKey {
    // Machine ids are global. Both the custodian source and its admitted guest viewer
    // address the same state; socket authority is checked against that admitted state.
    return JSON.stringify([input.sourceMachineId, input.targetMachineId, input.streamId]);
}

function readMachineId(socket: Socket): string {
    const data = socket.data as { machineId?: unknown; clientType?: unknown };
    return data.clientType === 'machine-scoped' && typeof data.machineId === 'string' ? data.machineId : '';
}

function readEnvelopeStreamId(envelope: MachineLiveStreamRelayEnvelopeV1): string | null {
    const message = envelope.message;
    if (message.kind === 'start' || message.kind === 'renew') return message.startRequest.streamId;
    if (message.kind === 'start_response') return message.startResponse.streamId;
    if (message.kind === 'metering') return message.metering.streamId;
    if (message.kind === 'frame') return message.frame.streamId;
    if (message.kind === 'receipt') {
        return message.receipt.streamId;
    }
    if (message.kind === 'control' || message.kind === 'sideband_control') return message.control.streamId;
    return null;
}

function isUserScopedSocket(socket: Socket): boolean {
    const data = socket.data as { clientType?: unknown };
    return data.clientType === 'user-scoped';
}

function isLegacyTargetMachineSocket(input: Readonly<{
    socketMachineId: string;
    envelope: MachineLiveStreamRelayEnvelopeV1;
}>): boolean {
    return input.socketMachineId !== ''
        && input.envelope.targetMachineId === input.socketMachineId
        && !input.envelope.viewerSocketId;
}

function isConsumerControlSocketForState(input: Readonly<{
    userId: string;
    socketMachineId: string;
    socketViewerId: string;
    envelope: MachineLiveStreamRelayEnvelopeV1;
    state: MachineLiveStreamRelayState | undefined;
}>): boolean {
    const state = input.state;
    if (!state) return isLegacyTargetMachineSocket(input);
    if (state.viewerSocketId) {
        return input.userId === readViewerAccountId(state)
            && input.socketViewerId !== ''
            && input.socketViewerId === state.viewerSocketId
            && input.envelope.viewerSocketId === state.viewerSocketId;
    }
    return input.userId === state.userId && isLegacyTargetMachineSocket(input);
}

function readViewerAccountId(state: MachineLiveStreamRelayState): string {
    const payload = state.startRequest.authorization?.payload;
    return payload?.v === 2 ? payload.viewerAccountId : state.userId;
}

function hasSameAuthorizationBinding(previous: MachineLiveStreamStartRequestV1, next: MachineLiveStreamStartRequestV1): boolean {
    const previousPayload = previous.authorization?.payload;
    const nextPayload = next.authorization?.payload;
    if (previousPayload?.v !== nextPayload?.v) return false;
    if (previousPayload?.v !== 2 || nextPayload?.v !== 2) return true;
    return previousPayload.viewerAccountId === nextPayload.viewerAccountId
        && previousPayload.sourceMachineInstallationId === nextPayload.sourceMachineInstallationId
        && JSON.stringify(previousPayload.personalSourceAdmission) === JSON.stringify(nextPayload.personalSourceAdmission);
}

function emitError(socket: Socket, error: string): void {
    socket.emit(SOCKET_RPC_EVENTS.ERROR, {
        type: 'machine-live-stream',
        error,
    });
}

function emitToMachine(params: Readonly<{
    io: RelayIo;
    machineId: string;
    envelope: MachineLiveStreamRelayEnvelopeV1;
}>): void {
    const streamId = readEnvelopeStreamId(params.envelope);
    if (!streamId) return;
    const state = streamStateByKey.get(buildStreamKey({
        sourceMachineId: params.envelope.sourceMachineId, targetMachineId: params.envelope.targetMachineId, streamId }));
    if (!state) return;
    const installationId = params.machineId === state.sourceMachineId ? state.sourceMachineInstallationId
        : params.machineId === state.targetMachineId ? state.targetMachineInstallationId : null;
    if (!installationId) return;
    params.io.to(getMachineInstallationSocketRoom(state.userId, params.machineId, installationId)).emit(MACHINE_LIVE_STREAM_SOCKET_EVENT, params.envelope);
}

type EmitToConsumerResult =
    | Readonly<{ delivered: true }>
    | Readonly<{ delivered: false; reasonCode: typeof VIEWER_SOCKET_REQUIRED_REASON }>;

// Deliver a consumer-bound envelope (frames + viewer-side controls) to whichever consumer the
// stream was authorized for: a per-tab viewer socket (`io.to(viewerSocketId)`) when present,
// otherwise the legacy target-machine room when it is a distinct peer machine. Socket.IO
// auto-joins every socket to a private room named after its own id, so `io.to(viewerSocketId)`
// reaches exactly that tab and nothing else.
function emitToConsumer(params: Readonly<{
    io: RelayIo;
    userId: string;
    sourceMachineId: string;
    targetMachineId: string;
    viewerSocketId: string;
    envelope: MachineLiveStreamRelayEnvelopeV1;
}>): EmitToConsumerResult {
    if (params.viewerSocketId) {
        params.io.to(params.viewerSocketId).emit(MACHINE_LIVE_STREAM_SOCKET_EVENT, params.envelope);
        return { delivered: true };
    }
    if (params.targetMachineId === params.sourceMachineId) {
        return { delivered: false, reasonCode: VIEWER_SOCKET_REQUIRED_REASON };
    }
    emitToMachine({
        io: params.io,
        machineId: params.targetMachineId,
        envelope: params.envelope,
    });
    return { delivered: true };
}

function emitViewerSocketRequired(input: Readonly<{
    socket: Socket;
    envelope: MachineLiveStreamRelayEnvelopeV1;
    streamId: string;
}>): void {
    emitReceipt({
        socket: input.socket,
        envelope: input.envelope,
        receipt: {
            v: 1,
            id: PEER_MEDIATION_RECEIPTS.streamPaused,
            streamId: input.streamId,
            routeKind: 'server_relay',
            flowKind: 'live_stream',
            reasonCode: VIEWER_SOCKET_REQUIRED_REASON,
        },
    });
    emitError(input.socket, VIEWER_SOCKET_REQUIRED_REASON);
}

function createStateStopControlEnvelope(
    state: MachineLiveStreamRelayState,
    reasonCode: string,
): MachineLiveStreamRelayEnvelopeV1 {
    return {
        v: 1,
        sourceMachineId: state.sourceMachineId,
        targetMachineId: state.targetMachineId,
        ...(state.viewerSocketId ? { viewerSocketId: state.viewerSocketId } : {}),
        message: {
            kind: 'control',
            control: {
                v: 1,
                streamId: state.streamId,
                kind: 'stop',
                reasonCode,
            },
        },
    };
}

function createControlEnvelope(
    envelope: MachineLiveStreamRelayEnvelopeV1,
    control: MachineLiveStreamControlV1,
): MachineLiveStreamRelayEnvelopeV1 {
    return {
        v: 1,
        sourceMachineId: envelope.sourceMachineId,
        targetMachineId: envelope.targetMachineId,
        ...(envelope.viewerSocketId ? { viewerSocketId: envelope.viewerSocketId } : {}),
        message: {
            kind: 'control',
            control,
        },
    };
}

function getFrameBytes(frame: MachineLiveStreamFrameV1): number {
    // The wire schema verifies this against decoded plain/encrypted bytes at ingress.
    return frame.payloadSizeBytes;
}

// Meter opaque wire bytes without decrypting them; metadata is not image cadence.
function meterFrame(frame: MachineLiveStreamFrameV1) {
    return { payloadKind: frame.payloadKind, payloadBase64: frame.payload.t === 'plain' ? frame.payload.v : frame.payload.c };
}

function fromBase64Url(value: string): Uint8Array | null {
    try {
        return Buffer.from(value, 'base64url');
    } catch {
        return null;
    }
}

function findRelayAuthorizationPublicKey(
    trustRoots: readonly RelayAuthorizationTrustRoot[] | undefined,
    keyId: string,
): Uint8Array | null {
    const root = trustRoots?.find((entry) => entry.keyId === keyId);
    if (!root) return null;
    const publicKey = fromBase64Url(root.publicKeyBase64Url);
    if (!publicKey || publicKey.length !== tweetnacl.sign.publicKeyLength) return null;
    return publicKey;
}

function countActiveStreams(predicate: (state: MachineLiveStreamRelayState) => boolean): number {
    let count = 0;
    for (const state of streamStateByKey.values()) {
        if (predicate(state)) count += 1;
    }
    return count;
}

function canStartStream(input: Readonly<{
    userId: string;
    sourceMachineId: string;
    socketStreamCount: number;
    caps: MachineLiveStreamRelayCaps;
}>): string | null {
    if (input.caps.maxConcurrentStreamsPerSocket !== undefined
        && input.socketStreamCount >= input.caps.maxConcurrentStreamsPerSocket) {
        return 'max_concurrent_streams_per_socket_exceeded';
    }
    if (
        input.caps.maxConcurrentStreamsPerAccount !== undefined
        && countActiveStreams((state) => state.userId === input.userId)
        >= input.caps.maxConcurrentStreamsPerAccount
    ) {
        return 'max_concurrent_streams_per_account_exceeded';
    }
    if (
        input.caps.maxConcurrentStreamsPerMachine !== undefined
        && countActiveStreams((state) => state.userId === input.userId && state.sourceMachineId === input.sourceMachineId)
        >= input.caps.maxConcurrentStreamsPerMachine
    ) {
        return 'max_concurrent_streams_per_machine_exceeded';
    }
    return null;
}

function createState(input: Readonly<{
    key: MachineLiveStreamKey;
    userId: string;
    encryptionMode: 'plain' | 'e2ee';
    streamId: string;
    sourceMachineId: string;
    targetMachineId: string;
    sourceMachineInstallationId: string;
    targetMachineInstallationId: string;
    viewerSocketId: string;
    startRequest: MachineLiveStreamStartRequestV1;
    caps: MachineLiveStreamRelayCaps;
    maxWindowFrames: number;
    maxWindowBytes: number;
    nowMs: number;
    expiresAtMs: number;
    retireAfterSessionAccessChange?: () => void | Promise<void>;
}>): MachineLiveStreamRelayState {
    const existing = streamStateByKey.get(input.key);
    if (existing) return existing;
    const next: MachineLiveStreamRelayState = {
        userId: input.userId,
        encryptionMode: input.encryptionMode,
        streamId: input.streamId,
        sourceMachineId: input.sourceMachineId,
        targetMachineId: input.targetMachineId,
        sourceMachineInstallationId: input.sourceMachineInstallationId,
        targetMachineInstallationId: input.targetMachineInstallationId,
        viewerSocketId: input.viewerSocketId,
        startRequest: input.startRequest,
        caps: input.caps,
        maxWindowFrames: input.maxWindowFrames,
        maxWindowBytes: input.maxWindowBytes,
        startedAtMs: input.nowMs,
        expiresAtMs: input.expiresAtMs,
        bytesRelayed: 0,
        bytesDropped: 0,
        framesRelayed: 0,
        framesDropped: 0,
        bandwidthPressure: false,
        meter: createMachineLiveStreamMeter({ caps: input.caps, startedAtMs: input.nowMs }),
        queuedFrames: [],
        // Server relay owns the bounded viewer delivery window. It opens with one image so a
        // newly started viewer can render a keyframe, then socket-authorized viewer acks
        // replenish the window in `applyAckControl`. Metadata shares its byte credit.
        availableWindowFrames: 1,
        availableWindowBytes: input.maxWindowBytes,
        nextSequenceToRelay: 1,
        lastAckNextSequence: 1,
        awaitingKeyframe: false,
        ...(input.retireAfterSessionAccessChange ? { retireAfterSessionAccessChange: input.retireAfterSessionAccessChange } : {}),
    };
    streamStateByKey.set(input.key, next);
    return next;
}

function isRelayStateExpired(state: MachineLiveStreamRelayState, nowMs: number): boolean {
    return nowMs >= state.expiresAtMs;
}

function pruneInactiveSocketStreamKeys(socketStreamKeys: Set<MachineLiveStreamKey>): void {
    for (const streamKey of socketStreamKeys) {
        if (!streamStateByKey.has(streamKey)) socketStreamKeys.delete(streamKey);
    }
}

function emitCapFailure(input: Readonly<{
    socket: Socket;
    io: RelayIo;
    userId: string;
    state: MachineLiveStreamRelayState;
    envelope: MachineLiveStreamRelayEnvelopeV1;
    reasonCode: string;
}>): void {
    const controlEnvelope = createStateStopControlEnvelope(input.state, input.reasonCode);
    const delivered = emitToConsumer({
        io: input.io,
        userId: input.userId,
        sourceMachineId: input.envelope.sourceMachineId,
        targetMachineId: input.envelope.targetMachineId,
        viewerSocketId: input.state.viewerSocketId,
        envelope: controlEnvelope,
    });
    if (!delivered.delivered) {
        emitViewerSocketRequired({
            socket: input.socket,
            envelope: controlEnvelope,
            streamId: controlEnvelope.message.kind === 'control' ? controlEnvelope.message.control.streamId : 'unknown',
        });
    }
    emitToMachine({
        io: input.io,
        machineId: input.envelope.sourceMachineId,
        envelope: controlEnvelope,
    });
    input.socket.emit(MACHINE_LIVE_STREAM_SOCKET_EVENT, {
        v: 1,
        sourceMachineId: input.envelope.sourceMachineId,
        targetMachineId: input.envelope.targetMachineId,
        message: {
            kind: 'receipt',
            receipt: {
                v: 1,
                id: PEER_MEDIATION_RECEIPTS.streamBandwidthCapped,
                streamId: controlEnvelope.message.kind === 'control' ? controlEnvelope.message.control.streamId : 'unknown',
                routeKind: 'server_relay',
                flowKind: 'live_stream',
                reasonCode: input.reasonCode,
            },
        },
    });
    emitError(input.socket, input.reasonCode);
}

function validateRelayAuthorization(input: Readonly<{
    userId: string;
    startRequest: MachineLiveStreamStartRequestV1;
    trustRoots?: readonly RelayAuthorizationTrustRoot[];
}>): string | null {
    const authorization = input.startRequest.authorization;
    if (!authorization) return 'live_stream_authorization_required';
    const payload = authorization.payload;
    if (payload.accountId !== input.userId) return 'live_stream_authorization_mismatch';
    // Protocol's parsed StartRequest owns request/payload consistency, including the
    // personal source binding. Authenticate its issuer and principal before using its recipient.
    const publicKey = findRelayAuthorizationPublicKey(input.trustRoots, authorization.signature.keyId);
    if (!publicKey) return 'live_stream_authorization_unknown_key';
    const signature = fromBase64Url(authorization.signature.valueBase64Url);
    if (!signature || signature.length !== tweetnacl.sign.signatureLength) {
        return 'live_stream_authorization_bad_signature';
    }
    const signingInput = Buffer.from(createMachineLiveStreamRelayAuthorizationSigningInputV1(payload), 'utf8');
    if (!tweetnacl.sign.detached.verify(signingInput, signature, publicKey)) {
        return 'live_stream_authorization_bad_signature';
    }
    return null;
}

function validateRelayAuthorizationTime(
    authorization: NonNullable<MachineLiveStreamStartRequestV1['authorization']>,
    nowMs: number,
): string | null {
    if (authorization.payload.exp <= nowMs) return 'live_stream_authorization_expired';
    if (authorization.payload.iat > nowMs) return 'live_stream_authorization_not_yet_valid';
    return null;
}

function emitReceipt(input: Readonly<{
    socket: Socket;
    envelope: MachineLiveStreamRelayEnvelopeV1;
    receipt: unknown;
}>): void {
    input.socket.emit(MACHINE_LIVE_STREAM_SOCKET_EVENT, {
        v: 1,
        sourceMachineId: input.envelope.sourceMachineId,
        targetMachineId: input.envelope.targetMachineId,
        message: {
            kind: 'receipt',
            receipt: input.receipt,
        },
    });
}

function createFrameEnvelope(
    state: MachineLiveStreamRelayState,
    frame: MachineLiveStreamFrameV1,
): MachineLiveStreamRelayEnvelopeV1 {
    return {
        v: 1,
        sourceMachineId: state.sourceMachineId,
        targetMachineId: state.targetMachineId,
        ...(state.viewerSocketId ? { viewerSocketId: state.viewerSocketId } : {}),
        message: {
            kind: 'frame',
            frame,
        },
    };
}

function emitKeyframeRequired(input: Readonly<{
    socket: Socket;
    io: RelayIo;
    userId: string;
    state: MachineLiveStreamRelayState;
    envelope: MachineLiveStreamRelayEnvelopeV1;
}>): void {
    const controlEnvelope: MachineLiveStreamRelayEnvelopeV1 = {
        v: 1,
        sourceMachineId: input.state.sourceMachineId,
        targetMachineId: input.state.targetMachineId,
        ...(input.state.viewerSocketId ? { viewerSocketId: input.state.viewerSocketId } : {}),
        message: {
            kind: 'control',
            control: {
                v: 1,
                streamId: input.state.streamId,
                kind: 'keyframe_required',
                reasonCode: 'relay_window_pressure',
            },
        },
    };
    emitToMachine({
        io: input.io,
        machineId: input.state.sourceMachineId,
        envelope: controlEnvelope,
    });
    const delivered = emitToConsumer({
        io: input.io,
        userId: input.userId,
        sourceMachineId: input.envelope.sourceMachineId,
        targetMachineId: input.envelope.targetMachineId,
        viewerSocketId: input.state.viewerSocketId,
        envelope: controlEnvelope,
    });
    if (!delivered.delivered) {
        emitViewerSocketRequired({
            socket: input.socket,
            envelope: controlEnvelope,
            streamId: input.state.streamId,
        });
    }
}

function applyRelayWindowPressure(input: Readonly<{
    socket: Socket;
    io: RelayIo;
    userId: string;
    state: MachineLiveStreamRelayState;
    envelope: MachineLiveStreamRelayEnvelopeV1;
}>): void {
    const pressured = applyMachineLiveStreamRelayBackpressure({
        streamId: input.state.streamId,
        routeKind: 'server_relay',
        frames: input.state.queuedFrames,
        maxWindowFrames: input.state.maxWindowFrames,
        maxWindowBytes: input.state.maxWindowBytes,
        reportPressure: !input.state.bandwidthPressure,
    });
    input.state.queuedFrames = [...pressured.frames];
    input.state.framesDropped += pressured.framesDropped;
    input.state.bytesDropped += pressured.bytesDropped;
    if (pressured.framesDropped > 0) input.state.bandwidthPressure = true;
    if (pressured.receipt) {
        emitReceipt({
            socket: input.socket,
            envelope: input.envelope,
            receipt: pressured.receipt,
        });
    }
    if (pressured.requiresKeyframeResync && !input.state.awaitingKeyframe) {
        input.state.awaitingKeyframe = true;
        emitKeyframeRequired(input);
    }
}

function enqueueRelayFrame(input: Readonly<{
    socket: Socket;
    io: RelayIo;
    userId: string;
    state: MachineLiveStreamRelayState;
    envelope: MachineLiveStreamRelayEnvelopeV1;
    frame: MachineLiveStreamFrameV1;
}>): void {
    if (input.state.awaitingKeyframe && input.frame.payloadKind === 'image_delta') {
        input.state.framesDropped += 1;
        input.state.bytesDropped += getFrameBytes(input.frame);
        return;
    }
    if (input.frame.payloadKind === 'image_keyframe') {
        if (input.state.awaitingKeyframe) input.state.bandwidthPressure = false;
        input.state.awaitingKeyframe = false;
    }
    input.state.queuedFrames.push(input.frame);
    applyRelayWindowPressure(input);
}

function drainRelayQueue(input: Readonly<{
    io: RelayIo;
    userId: string;
    state: MachineLiveStreamRelayState;
    nowMs: number;
    undeliverableSocket?: Socket;
    onCapFailure: (frame: MachineLiveStreamFrameV1, reasonCode: string) => void;
}>): void {
    while (input.state.queuedFrames.length > 0) {
        const nextFrame = input.state.queuedFrames[0]!;
        const mediaFrame = nextFrame.payloadKind !== 'metadata';
        if (mediaFrame && input.state.availableWindowFrames <= 0) return;
        if (input.state.awaitingKeyframe && nextFrame.payloadKind === 'image_delta') return;
        const frameBytes = getFrameBytes(nextFrame);
        if (frameBytes > input.state.availableWindowBytes) return;
        // Decide and record the aggregate/time budget once at its forwarding effect.
        const recorded = input.state.meter.recordFrame(meterFrame(nextFrame), input.nowMs);
        if (!recorded.ok) {
            input.onCapFailure(nextFrame, recorded.reasonCode);
            return;
        }
        input.state.queuedFrames.shift();
        const envelope = createFrameEnvelope(input.state, nextFrame);
        const delivered = emitToConsumer({
            io: input.io,
            userId: input.userId,
            sourceMachineId: input.state.sourceMachineId,
            targetMachineId: input.state.targetMachineId,
            viewerSocketId: input.state.viewerSocketId,
            envelope,
        });
        if (!delivered.delivered) {
            input.state.framesDropped += 1;
            input.state.bytesDropped += frameBytes;
            if (input.undeliverableSocket) {
                emitViewerSocketRequired({
                    socket: input.undeliverableSocket,
                    envelope,
                    streamId: nextFrame.streamId,
                });
            }
            return;
        }
        if (mediaFrame) input.state.availableWindowFrames -= 1;
        input.state.availableWindowBytes -= frameBytes;
        input.state.bytesRelayed = recorded.metering.bytesSent;
        input.state.framesRelayed = recorded.metering.framesSent;
        if (!input.state.awaitingKeyframe && input.state.queuedFrames.length === 0) input.state.bandwidthPressure = false;
        input.state.nextSequenceToRelay = Math.max(input.state.nextSequenceToRelay, nextFrame.sequence + 1);
    }
}

function applyAckControl(input: Readonly<{
    socket: Socket;
    io: RelayIo;
    userId: string;
    state: MachineLiveStreamRelayState;
    control: Extract<MachineLiveStreamControlV1, { kind: 'ack' }>;
    nowMs: number;
    onCapFailure: (frame: MachineLiveStreamFrameV1, reasonCode: string) => void;
}>): boolean {
    if (
        input.control.nextSequence < input.state.nextSequenceToRelay
        || input.control.nextSequence < input.state.lastAckNextSequence
    ) {
        emitError(input.socket, 'stale_live_stream_ack');
        return false;
    }
    input.state.lastAckNextSequence = input.control.nextSequence;
    input.state.availableWindowFrames = Math.min(input.state.maxWindowFrames, Math.max(0, Math.floor(
        input.control.windowFrames ?? input.state.maxWindowFrames,
    )));
    input.state.availableWindowBytes = Math.min(input.state.maxWindowBytes, Math.max(0, Math.floor(
        input.control.windowBytes ?? input.state.maxWindowBytes,
    )));
    drainRelayQueue({
        io: input.io,
        userId: input.userId,
        state: input.state,
        nowMs: input.nowMs,
        undeliverableSocket: input.socket,
        onCapFailure: input.onCapFailure,
    });
    return true;
}

export function machineLiveStreamRelayHandler(
    userId: string,
    socket: Socket,
    ctx: Readonly<{
        io: RelayIo;
        resolveAccountEncryptionMode?: () => Promise<'plain' | 'e2ee' | null>;
        readMachineAdmission?: (machineId: string) => ReturnType<typeof resolveMachineAdmission>;
        serverRoutedLiveStreamEnabled?: boolean;
        relayCaps?: MachineLiveStreamRelayCaps | null;
        relayAuthorizationTrustRoots?: readonly RelayAuthorizationTrustRoot[];
        relayWindowFrames?: number;
        relayWindowBytes?: number;
        socketMaxHttpBufferSize?: number;
        nowMs?: () => number;
        verifyViewerSocketOwnership?: PeerMediationViewerSocketOwnershipVerifier;
        readViewerSessionAuthentication?: PeerMediationViewerSessionAuthenticationReader;
        observability?: PeerMediationObservabilityEmitter;
    }>,
): void {
    const socketStreamKeys = new Set<MachineLiveStreamKey>();
    let disconnected = false;
    const socketMaxHttpBufferSize = ctx.socketMaxHttpBufferSize ?? resolveSocketMaxHttpBufferSizeFromEnv(process.env);
    const readMachineAdmission = ctx.readMachineAdmission ?? ((machineId: string) => resolveMachineAdmission({ actorAccountId: userId, machineId }));

    const readCurrentInstallations = async (sourceMachineId: string, targetMachineId: string,
        expected?: Pick<MachineLiveStreamRelayState, 'sourceMachineInstallationId' | 'targetMachineInstallationId'>,
    ): Promise<{ sourceMachineInstallationId: string; targetMachineInstallationId: string } | null> => {
        try {
            const sourceAdmission = readMachineAdmission(sourceMachineId);
            const [source, target] = await Promise.all([
                sourceAdmission,
                sourceMachineId === targetMachineId ? sourceAdmission : readMachineAdmission(targetMachineId),
            ]);
            if (source.kind !== 'admitted' || target.kind !== 'admitted'
                || source.custodianAccountId !== userId || target.custodianAccountId !== userId
                || source.actorAccountId !== userId || target.actorAccountId !== userId
                || (expected && (source.installationId !== expected.sourceMachineInstallationId || target.installationId !== expected.targetMachineInstallationId))) return null;
            const socketMachineId = readMachineId(socket);
            if (socketMachineId) {
                const installationId = socketMachineId === sourceMachineId ? source.installationId : target.installationId;
                if (socket.data.verifiedMachineInstallationId !== installationId) return null;
            }
            return { sourceMachineInstallationId: source.installationId, targetMachineInstallationId: target.installationId };
        } catch { return null; }
    };

    const emitObservability = (input: Readonly<{
        accountId?: string;
        streamId: string;
        sourceMachineId: string;
        kind: Parameters<typeof createPeerMediationFlowEvent>[0]['kind'];
        reasonCode?: string;
        bytesIn?: number;
        bytesOut?: number;
        metadata?: Readonly<Record<string, unknown>>;
    }>): void => {
        ctx.observability?.emit(createPeerMediationFlowEvent({
            accountId: input.accountId ?? userId,
            machineId: input.sourceMachineId,
            flowKind: 'live_stream',
            flowId: input.streamId,
            routeKind: 'server_relay',
            kind: input.kind,
            nowMs: ctx.nowMs?.() ?? Date.now(),
            ...(input.reasonCode ? { reasonCode: input.reasonCode } : {}),
            ...(input.bytesIn !== undefined ? { bytesIn: input.bytesIn } : {}),
            ...(input.bytesOut !== undefined ? { bytesOut: input.bytesOut } : {}),
            ...(input.metadata ? { metadata: input.metadata } : {}),
        }));
    };

    const removeStream = (streamKey: MachineLiveStreamKey): void => {
        streamStateByKey.delete(streamKey);
        socketStreamKeys.delete(streamKey);
    };

    // Centralized terminal close: read the server-authoritative byte facts off
    // the relay state, emit the distinct close-kind observability event, then
    // tear the stream down. Every terminal path (cap denial, expiry, explicit
    // stop, disconnect) routes through here so the server's relayed/dropped
    // byte facts reach the diagnostics tier instead of dying in per-stream state.
    const closeStreamWithObservability = (input: Readonly<{
        streamKey: MachineLiveStreamKey;
        kind: Parameters<typeof createPeerMediationFlowEvent>[0]['kind'];
        reasonCode?: string;
    }>): void => {
        const state = streamStateByKey.get(input.streamKey);
        if (state) {
            emitObservability({
                accountId: state.userId,
                streamId: state.streamId,
                sourceMachineId: state.sourceMachineId,
                kind: input.kind,
                ...(input.reasonCode ? { reasonCode: input.reasonCode } : {}),
                bytesIn: state.bytesRelayed + state.bytesDropped,
                bytesOut: state.bytesRelayed,
                metadata: {
                    bytesRelayed: state.bytesRelayed,
                    bytesDropped: state.bytesDropped,
                    framesRelayed: state.framesRelayed,
                    framesDropped: state.framesDropped,
                    targetMachineId: state.targetMachineId,
                },
            });
        }
        removeStream(input.streamKey);
    };

    const closeCapExceeded = (
        streamKey: MachineLiveStreamKey,
        state: MachineLiveStreamRelayState,
        frame: MachineLiveStreamFrameV1,
        reasonCode: string,
    ): void => {
        emitCapFailure({ socket, io: ctx.io, userId, state, envelope: createFrameEnvelope(state, frame), reasonCode });
        closeStreamWithObservability({ streamKey, kind: 'cap.exceeded', reasonCode });
    };

    const closeExpiredState = (streamKey: MachineLiveStreamKey, state: MachineLiveStreamRelayState): void => {
        const envelope = createStateStopControlEnvelope(state, 'live_stream_authorization_expired');
        emitToConsumer({ io: ctx.io, userId: state.userId, sourceMachineId: state.sourceMachineId,
            targetMachineId: state.targetMachineId, viewerSocketId: state.viewerSocketId, envelope });
        emitToMachine({ io: ctx.io, machineId: state.sourceMachineId, envelope });
        closeStreamWithObservability({ streamKey, kind: 'flow.errored', reasonCode: 'live_stream_authorization_expired' });
    };

    const closeStreamsForViewerSocket = (viewerSocketId: string): void => {
        for (const [streamKey, state] of [...streamStateByKey.entries()]) {
            if (readViewerAccountId(state) !== userId || state.viewerSocketId !== viewerSocketId) continue;
            emitToMachine({
                io: ctx.io,
                machineId: state.sourceMachineId,
                envelope: {
                    v: 1,
                    sourceMachineId: state.sourceMachineId,
                    targetMachineId: state.targetMachineId,
                    viewerSocketId: state.viewerSocketId,
                    message: {
                        kind: 'control',
                        control: {
                            v: 1,
                            streamId: state.streamId,
                            kind: 'stop',
                            reasonCode: 'viewer_disconnected',
                        },
                    },
                },
            });
            closeStreamWithObservability({
                streamKey,
                kind: 'flow.aborted',
                reasonCode: 'viewer_disconnected',
            });
        }
    };

    // The source connection owns its relay states. Guest access loss does not disconnect
    // the custodian's Machine socket, and a distinct V1 target's revocation or installation
    // replacement does not disconnect the source, so consume the existing local/cluster withdrawal.
    const releaseMachineAccessLoss = readMachineId(socket) ? eventRouter.onMachineAccessLoss(input => {
        for (const streamKey of socketStreamKeys) {
            const state = streamStateByKey.get(streamKey);
            if (!state) continue;
            const payload = state.startRequest.authorization?.payload;
            const withdrawn = payload?.v === 2
                ? !payload.sessionBrowserAccess && state.sourceMachineId === input.machineId
                    && readViewerAccountId(state) === input.accountId
                : state.userId === input.accountId
                    && (state.sourceMachineId === input.machineId || state.targetMachineId === input.machineId);
            if (!withdrawn) continue;
            const envelope = createStateStopControlEnvelope(state, 'machine_unavailable');
            emitToConsumer({ io: ctx.io, userId: state.userId, sourceMachineId: state.sourceMachineId,
                targetMachineId: state.targetMachineId, viewerSocketId: state.viewerSocketId, envelope });
            emitToMachine({ io: ctx.io, machineId: state.sourceMachineId, envelope });
            closeStreamWithObservability({ streamKey, kind: 'flow.aborted', reasonCode: 'machine_unavailable' });
        }
    }) : undefined;

    const handleEnvelope = (
        envelope: MachineLiveStreamRelayEnvelopeV1,
        streamId: string,
    ): void | Promise<void> => {
        if (disconnected) return;
        const socketMachineId = readMachineId(socket);
        // C3: a per-tab viewer is a user-scoped browser socket (not machine-scoped). It may only
        // send consumer-side control (ack/stop/etc.) for a stream minted against its own socket id.
        const socketViewerId = isUserScopedSocket(socket) ? socket.id : '';
        if (!socketMachineId && !socketViewerId) {
            emitError(socket, 'machine_scoped_socket_required');
            return;
        }

        const activeState = streamStateByKey.get(buildStreamKey({
            sourceMachineId: envelope.sourceMachineId, targetMachineId: envelope.targetMachineId, streamId,
        }));
        const isSourceSocket = socketMachineId !== '' && envelope.sourceMachineId === socketMachineId
            && (!activeState || (activeState.userId === userId
                && socket.data.verifiedMachineInstallationId === activeState.sourceMachineInstallationId));
        const isTargetControlSocket = isConsumerControlSocketForState({
            userId, socketMachineId, socketViewerId, envelope, state: activeState,
        });
        const isControlKind = (
            envelope.message.kind === 'control'
            || envelope.message.kind === 'sideband_control'
            || envelope.message.kind === 'renew'
        );
        // Initial shape gate only. Once the stream state is loaded, controls are authorized against
        // the minted state.viewerSocketId so a different tab cannot operate a stream by echoing its
        // own socket id in the envelope.
        const isPotentialTargetControlSocket = isControlKind && (
            (socketMachineId !== '' && envelope.targetMachineId === socketMachineId)
            || (socketViewerId !== '' && envelope.viewerSocketId === socketViewerId)
        );
        if (!isSourceSocket && !isPotentialTargetControlSocket) {
            emitError(socket, 'source_machine_mismatch');
            return;
        }

        if (envelope.message.kind !== 'start') {
            const message = envelope.message;
            if (message.kind === 'start_response' || message.kind === 'metering') {
                return;
            }
            const streamKey = buildStreamKey({ sourceMachineId: envelope.sourceMachineId,
                targetMachineId: envelope.targetMachineId, streamId });
            const state = streamStateByKey.get(streamKey);
            if (state && !isSourceSocket && !isTargetControlSocket) {
                emitError(socket, envelope.message.kind === 'control' && envelope.message.control.kind === 'ack'
                    ? 'target_machine_ack_required' : 'target_machine_control_required');
                return;
            }
            // START is the one Machine admission for both V1 and V2. Later envelopes consume
            // the admitted state and its bound installation sockets; withdrawal reaches an open
            // stream through the committed access-loss producer handled by this source socket.
        }

        if (envelope.message.kind === 'start') {
            if (!isSourceSocket) {
                emitError(socket, 'source_machine_mismatch');
                return;
            }
            const { startRequest } = envelope.message;
            const serverCaps = ctx.relayCaps;
            const streamKey = buildStreamKey({
                sourceMachineId: envelope.sourceMachineId,
                targetMachineId: envelope.targetMachineId,
                streamId: startRequest.streamId,
            });
            let verifiedViewerSocketId = '';
            const refuseStart = (reasonCode: string) => {
                // The source has already started capture before server admission settles.
                // Stop that exact authenticated socket; never trust a supplied viewer id.
                socket.emit(MACHINE_LIVE_STREAM_SOCKET_EVENT, createControlEnvelope({
                    ...envelope, viewerSocketId: startRequest.viewerSocketId,
                }, { v: 1, streamId: startRequest.streamId, kind: 'stop', reasonCode }));
                if (verifiedViewerSocketId) emitToConsumer({
                    io: ctx.io, userId, sourceMachineId: envelope.sourceMachineId,
                    targetMachineId: envelope.targetMachineId, viewerSocketId: verifiedViewerSocketId,
                    envelope: { v: 1, sourceMachineId: envelope.sourceMachineId,
                        targetMachineId: envelope.targetMachineId, viewerSocketId: verifiedViewerSocketId,
                        message: { kind: 'start_response', startResponse: {
                            v: 1, streamId: startRequest.streamId, accepted: false,
                            routeKind: 'server_relay', disabledReason: reasonCode,
                        } },
                    },
                });
                emitError(socket, reasonCode);
            };
            let admissionCancelled = false;
            let releaseAdmissionAccessLoss: (() => void) | undefined;
            const admission = (async () => {
                if (
                    startRequest.routeKind !== 'server_relay'
                    || startRequest.sourceMachineId !== envelope.sourceMachineId
                    || startRequest.targetMachineId !== envelope.targetMachineId
                ) {
                    refuseStart('invalid_live_stream_start');
                    return;
                }
                const authorizationFailure = validateRelayAuthorization({
                    userId,
                    startRequest,
                    trustRoots: ctx.relayAuthorizationTrustRoots,
                });
                if (authorizationFailure) {
                    emitObservability({
                        streamId: startRequest.streamId,
                        sourceMachineId: envelope.sourceMachineId,
                        kind: 'flow.denied',
                        reasonCode: authorizationFailure,
                    });
                    refuseStart(authorizationFailure);
                    return;
                }
                const viewerSocketId = startRequest.viewerSocketId ?? '';
                const authorizationPayload = startRequest.authorization!.payload;
                const sessionBrowserAccess = authorizationPayload.v === 2 ? authorizationPayload.sessionBrowserAccess : undefined;
                let viewerSessionAuthentication: SessionAccessAuthentication | null = null;
                if (authorizationPayload.v === 2 && !sessionBrowserAccess) {
                    // Access loss can arrive while admission awaits network or storage boundaries.
                    releaseAdmissionAccessLoss = eventRouter.onMachineAccessLoss(input => {
                        if (admissionCancelled || input.accountId !== authorizationPayload.viewerAccountId
                            || input.machineId !== envelope.sourceMachineId) return;
                        admissionCancelled = true;
                        socket.emit(MACHINE_LIVE_STREAM_SOCKET_EVENT, createControlEnvelope(envelope, {
                            v: 1, streamId: startRequest.streamId, kind: 'stop', reasonCode: 'machine_unavailable',
                        }));
                    });
                }
                if (viewerSocketId) {
                    const viewer = {
                        accountId: authorizationPayload.v === 2 ? authorizationPayload.viewerAccountId : userId,
                        socketId: viewerSocketId,
                    };
                    if (sessionBrowserAccess) viewerSessionAuthentication = await ctx.readViewerSessionAuthentication?.(viewer) ?? null;
                    const viewerOwned = sessionBrowserAccess ? viewerSessionAuthentication !== null
                        : await ctx.verifyViewerSocketOwnership?.(viewer);
                    if (viewerOwned !== true) {
                        emitObservability({
                            streamId: startRequest.streamId,
                            sourceMachineId: envelope.sourceMachineId,
                            kind: 'flow.denied',
                            reasonCode: 'viewer_socket_not_owned',
                        });
                        refuseStart('viewer_socket_not_owned');
                        return;
                    }
                    verifiedViewerSocketId = viewerSocketId;
                }
                if (ctx.serverRoutedLiveStreamEnabled !== true || !serverCaps) {
                    refuseStart('server_routed_live_stream_disabled');
                    return;
                }
                const expiresAtMs = startRequest.authorization?.payload.exp;
                if (!expiresAtMs) {
                    emitObservability({
                        streamId: startRequest.streamId,
                        sourceMachineId: envelope.sourceMachineId,
                        kind: 'flow.denied',
                        reasonCode: 'live_stream_authorization_required',
                    });
                    refuseStart('live_stream_authorization_required');
                    return;
                }
                const effectiveCaps = resolveMachineLiveStreamRelayCaps({
                    requested: startRequest,
                    serverCaps,
                });
                if (!effectiveCaps) {
                    const capsFailure = 'live_stream_caps_exceeded';
                    emitObservability({
                        streamId: startRequest.streamId,
                        sourceMachineId: envelope.sourceMachineId,
                        kind: 'flow.denied',
                        reasonCode: capsFailure,
                    });
                    refuseStart(capsFailure);
                    return;
                }

                let encryptionMode: 'plain' | 'e2ee' | null = null;
                try {
                    if (sessionBrowserAccess) {
                        const session = await db.session.findUnique({ where: { id: sessionBrowserAccess.sessionId }, select: { encryptionMode: true } });
                        encryptionMode = session?.encryptionMode === 'plain' || session?.encryptionMode === 'e2ee' ? session.encryptionMode : null;
                    } else encryptionMode = await ctx.resolveAccountEncryptionMode?.() ?? null;
                } catch { /* Fail closed. */ }
                if (disconnected) return;
                if (encryptionMode !== 'plain' && encryptionMode !== 'e2ee') {
                    refuseStart('stream_encryption_mode_unavailable');
                    return;
                }
                const installations = await readCurrentInstallations(envelope.sourceMachineId, envelope.targetMachineId, streamStateByKey.get(streamKey));
                if (!installations || disconnected || admissionCancelled || (authorizationPayload.v === 2
                    && installations.sourceMachineInstallationId !== authorizationPayload.sourceMachineInstallationId)) {
                    refuseStart('machine_unavailable');
                    return;
                }
                // Opening an interactive stream is a new admission, even when a still-valid
                // signed grant was minted before access changed. No later frame re-evaluates it.
                if (sessionBrowserAccess) {
                    if (!viewerSessionAuthentication) { refuseStart('capture_source_denied'); return; }
                    const decision = await resolveSessionAccessForOperation(db, { accountId: sessionBrowserAccess.actorAccountId,
                        sessionId: sessionBrowserAccess.sessionId, authentication: viewerSessionAuthentication,
                        capability: sessionBrowserAccess.effectiveAccess.capabilities.submitAgentInput ? 'submitAgentInput' : 'readTranscript' });
                    if (decision.status !== 'allowed') { refuseStart('capture_source_denied'); return; }
                    if (disconnected) return;
                }
                // Ownership and Account reads can outlive the signed admission window.
                // Re-sample at the synchronous state/resource admission boundary.
                const nowMs = ctx.nowMs?.() ?? Date.now();
                const timeFailure = validateRelayAuthorizationTime(startRequest.authorization!, nowMs);
                if (timeFailure) {
                    emitObservability({ streamId: startRequest.streamId, sourceMachineId: envelope.sourceMachineId,
                        kind: 'flow.denied', reasonCode: timeFailure });
                    refuseStart(timeFailure);
                    return;
                }

                for (const [expiredKey, expiredState] of streamStateByKey) {
                    if (isRelayStateExpired(expiredState, nowMs)) closeExpiredState(expiredKey, expiredState);
                }
                pruneInactiveSocketStreamKeys(socketStreamKeys);
                const currentState = streamStateByKey.get(streamKey);
                if (currentState && (currentState.viewerSocketId !== viewerSocketId
                    || !hasSameAuthorizationBinding(currentState.startRequest, startRequest))) {
                    emitObservability({
                        streamId: startRequest.streamId,
                        sourceMachineId: envelope.sourceMachineId,
                        kind: 'flow.denied',
                        reasonCode: 'live_stream_viewer_mismatch',
                    });
                    refuseStart('live_stream_viewer_mismatch');
                    return;
                }
                // A still-live state for this key means this start is an idempotent
                // re-attach; only a genuinely new relay state emits the start/ready
                // lifecycle so diagnostics are not duplicated on retried starts.
                const isNewStream = !streamStateByKey.has(streamKey);
                if (!socketStreamKeys.has(streamKey)) {
                    const concurrencyFailure = canStartStream({
                        userId,
                        sourceMachineId: envelope.sourceMachineId,
                        socketStreamCount: socketStreamKeys.size,
                        caps: serverCaps,
                    });
                    if (concurrencyFailure) {
                        emitObservability({
                            streamId: startRequest.streamId,
                            sourceMachineId: envelope.sourceMachineId,
                            kind: 'flow.denied',
                            reasonCode: concurrencyFailure,
                        });
                        refuseStart(concurrencyFailure);
                        return;
                    }
                }
                createState({
                    key: streamKey,
                    userId,
                    encryptionMode,
                    streamId: startRequest.streamId,
                    sourceMachineId: envelope.sourceMachineId,
                    targetMachineId: envelope.targetMachineId,
                    ...installations,
                    viewerSocketId,
                    startRequest,
                    caps: { ...serverCaps, ...effectiveCaps },
                    maxWindowFrames: Math.max(1, Math.floor(ctx.relayWindowFrames ?? 1)),
                    maxWindowBytes: Math.max(1, Math.floor(ctx.relayWindowBytes ?? socketMaxHttpBufferSize)),
                    nowMs,
                    expiresAtMs,
                    ...(sessionBrowserAccess ? { retireAfterSessionAccessChange: async () => {
                        try {
                            const currentAccess = await resolveSessionAccessForOperation(db, {
                                accountId: sessionBrowserAccess.actorAccountId,
                                sessionId: sessionBrowserAccess.sessionId,
                                // Captured only after the Session Browser admission above established authentication.
                                authentication: viewerSessionAuthentication!,
                                capability: sessionBrowserAccess.effectiveAccess.capabilities.submitAgentInput
                                    ? 'submitAgentInput' : 'readTranscript',
                            });
                            if (currentAccess.status === 'allowed') return;
                        } catch { /* Fail closed at the access-change boundary. */ }
                        const state = streamStateByKey.get(streamKey);
                        if (!state) return;
                        const stop = createStateStopControlEnvelope(state, 'capture_source_denied');
                        emitToConsumer({ io: ctx.io, userId: state.userId, sourceMachineId: state.sourceMachineId,
                            targetMachineId: state.targetMachineId, viewerSocketId: state.viewerSocketId, envelope: stop });
                        emitToMachine({ io: ctx.io, machineId: state.sourceMachineId, envelope: stop });
                        closeStreamWithObservability({ streamKey, kind: 'flow.aborted', reasonCode: 'capture_source_denied' });
                    } } : {}),
                });
                socketStreamKeys.add(streamKey);
                if (isNewStream) {
                    emitObservability({
                        streamId: startRequest.streamId,
                        sourceMachineId: envelope.sourceMachineId,
                        kind: 'flow.started',
                    });
                    emitObservability({
                        streamId: startRequest.streamId,
                        sourceMachineId: envelope.sourceMachineId,
                        kind: 'flow.ready',
                    });
                }
            })();
            return admission.finally(() => { releaseAdmissionAccessLoss?.(); });
        }

        if (envelope.message.kind === 'renew') {
            const { startRequest } = envelope.message;
            const streamKey = buildStreamKey({
                sourceMachineId: envelope.sourceMachineId,
                targetMachineId: envelope.targetMachineId,
                streamId: startRequest.streamId,
            });
            const state = streamStateByKey.get(streamKey);
            if (!state) {
                emitError(socket, 'live_stream_start_required');
                return;
            }
            if (!isSourceSocket && !isTargetControlSocket) {
                emitError(socket, 'target_machine_control_required');
                return;
            }
            const nowMs = ctx.nowMs?.() ?? Date.now();
            const authorizationFailure = validateRelayAuthorization({
                userId: state.userId, startRequest, trustRoots: ctx.relayAuthorizationTrustRoots,
            }) ?? (startRequest.authorization ? validateRelayAuthorizationTime(startRequest.authorization, nowMs) : null);
            if (authorizationFailure) {
                emitError(socket, authorizationFailure);
                return;
            }
            const immutableFields = [
                'streamId', 'streamFamily', 'sourceId', 'routeKind', 'sourceMachineId', 'targetMachineId',
                'viewerSocketId', 'codecId', 'maxBitrateBps', 'maxFramesPerSecond', 'maxFrameBytes',
                'maxDurationMs', 'maxTotalBytes',
            ] as const;
            if (immutableFields.some((field) => startRequest[field] !== state.startRequest[field])
                || JSON.stringify(startRequest.viewerCodecs) !== JSON.stringify(state.startRequest.viewerCodecs)) {
                emitError(socket, 'live_stream_authorization_mismatch');
                return;
            }
            if (!hasSameAuthorizationBinding(state.startRequest, startRequest)) {
                emitError(socket, 'live_stream_authorization_mismatch');
                return;
            }
            const expiresAtMs = startRequest.authorization!.payload.exp;
            if (expiresAtMs <= state.expiresAtMs) {
                emitError(socket, 'live_stream_authorization_mismatch');
                return;
            }
            if (isRelayStateExpired(state, nowMs)) {
                closeExpiredState(streamKey, state);
                return;
            }
            state.expiresAtMs = expiresAtMs;
            state.startRequest = startRequest;
            if (!isSourceSocket) emitToMachine({ io: ctx.io, machineId: state.sourceMachineId, envelope });
            emitToConsumer({
                io: ctx.io, userId, sourceMachineId: state.sourceMachineId, targetMachineId: state.targetMachineId,
                viewerSocketId: state.viewerSocketId,
                envelope: createControlEnvelope(envelope, { v: 1, streamId: state.streamId, kind: 'grant_expiring', expiresAtMs }),
            });
            return;
        }

        if (envelope.message.kind === 'frame') {
            if (!isSourceSocket) {
                emitError(socket, 'source_machine_mismatch');
                return;
            }
            const streamKey = buildStreamKey({
                sourceMachineId: envelope.sourceMachineId,
                targetMachineId: envelope.targetMachineId,
                streamId: envelope.message.frame.streamId,
            });
            const state = streamStateByKey.get(streamKey);
            if (!state || !socketStreamKeys.has(streamKey)) {
                emitError(socket, 'live_stream_start_required');
                return;
            }
            if ((state.encryptionMode === 'plain') !== (envelope.message.frame.payload.t === 'plain')) {
                emitError(socket, 'stream_payload_mode_mismatch');
                return;
            }
            const nowMs = ctx.nowMs?.() ?? Date.now();
            if (Buffer.byteLength(JSON.stringify(envelope), 'utf8') > socketMaxHttpBufferSize) {
                closeCapExceeded(streamKey, state, envelope.message.frame, 'socket_message_bytes_exceeded');
                return;
            }
            if (isRelayStateExpired(state, nowMs)) {
                closeExpiredState(streamKey, state);
                emitError(socket, 'live_stream_authorization_expired');
                return;
            }
            // An oversized frame can never drain; refuse it before retaining it.
            if (state.caps.maxFrameBytes !== undefined && getFrameBytes(envelope.message.frame) > state.caps.maxFrameBytes) {
                closeCapExceeded(streamKey, state, envelope.message.frame, 'max_frame_bytes_exceeded');
                return;
            }
            enqueueRelayFrame({
                socket,
                io: ctx.io,
                userId,
                state,
                envelope,
                frame: envelope.message.frame,
            });
            drainRelayQueue({
                io: ctx.io,
                userId,
                state,
                nowMs,
                undeliverableSocket: socket,
                onCapFailure: (frame, reasonCode) => closeCapExceeded(streamKey, state, frame, reasonCode),
            });
            return;
        }

        if (envelope.message.kind === 'receipt') {
            const receipt = envelope.message.receipt;
            if (!isSourceSocket || receipt.routeKind !== 'server_relay') {
                emitError(socket, 'source_machine_mismatch');
                return;
            }
            const streamKey = buildStreamKey({
                sourceMachineId: envelope.sourceMachineId,
                targetMachineId: envelope.targetMachineId,
                streamId: receipt.streamId,
            });
            const state = streamStateByKey.get(streamKey);
            if (!state || !socketStreamKeys.has(streamKey)) {
                emitError(socket, 'live_stream_start_required');
                return;
            }
            emitToConsumer({
                io: ctx.io,
                userId,
                sourceMachineId: state.sourceMachineId,
                targetMachineId: state.targetMachineId,
                viewerSocketId: state.viewerSocketId,
                envelope: {
                    v: 1,
                    sourceMachineId: state.sourceMachineId,
                    targetMachineId: state.targetMachineId,
                    ...(state.viewerSocketId ? { viewerSocketId: state.viewerSocketId } : {}),
                    message: { ...envelope.message, kind: 'receipt', receipt },
                },
            });
            if (isMachineLiveStreamTerminalReceiptV1(receipt)) {
                closeStreamWithObservability({
                    streamKey,
                    kind: receipt.terminalOutcome === 'error' ? 'flow.errored' : 'flow.closed',
                    reasonCode: receipt.reasonCode,
                });
            }
            return;
        }

        if (envelope.message.kind === 'control') {
            const streamKey = buildStreamKey({
                sourceMachineId: envelope.sourceMachineId,
                targetMachineId: envelope.targetMachineId,
                streamId: envelope.message.control.streamId,
            });
            const state = streamStateByKey.get(streamKey);
            if (envelope.message.control.kind === 'ack') {
                if (!state && socketViewerId) {
                    emitError(socket, 'live_stream_start_required');
                    return;
                }
                if (!isTargetControlSocket) {
                    emitError(socket, 'target_machine_ack_required');
                    return;
                }
                if (!state) {
                    emitError(socket, 'live_stream_start_required');
                    return;
                }
                const nowMs = ctx.nowMs?.() ?? Date.now();
                if (isRelayStateExpired(state, nowMs)) {
                    closeExpiredState(streamKey, state);
                    emitError(socket, 'live_stream_authorization_expired');
                    return;
                }
                const accepted = applyAckControl({
                    socket,
                    io: ctx.io,
                    userId,
                    state,
                    control: envelope.message.control,
                    nowMs,
                    onCapFailure: (frame, reasonCode) => closeCapExceeded(streamKey, state, frame, reasonCode),
                });
                if (!accepted) return;
                // Relay credit stays here; demand-driven capture also needs the
                // admitted acknowledgement to produce its next frame.
                emitToMachine({
                    io: ctx.io,
                    machineId: state.sourceMachineId,
                    envelope,
                });
                return;
            }
            if (!state && (socketViewerId || (isSourceSocket && envelope.targetMachineId !== envelope.sourceMachineId))) {
                emitError(socket, 'live_stream_start_required');
                return;
            }
            if (!isSourceSocket && !isTargetControlSocket) {
                emitError(socket, 'target_machine_control_required');
                return;
            }
            if (isSourceSocket) {
                // Source-initiated control flows to the consumer (per-tab viewer when the stream
                // was minted with a viewerSocketId, otherwise the legacy target machine room).
                const delivered = emitToConsumer({
                    io: ctx.io,
                    userId,
                    sourceMachineId: envelope.sourceMachineId,
                    targetMachineId: envelope.targetMachineId,
                    viewerSocketId: state?.viewerSocketId ?? '',
                    envelope,
                });
                if (!delivered.delivered) {
                    emitViewerSocketRequired({
                        socket,
                        envelope,
                        streamId: envelope.message.control.streamId,
                    });
                }
            } else {
                // Consumer-initiated control flows to the source machine.
                emitToMachine({
                    io: ctx.io,
                    machineId: envelope.sourceMachineId,
                    envelope,
                });
            }
            // Installation-bound routing needs the admitted state until the
            // terminal control has reached the opposite endpoint.
            if (envelope.message.control.kind === 'stop') {
                closeStreamWithObservability({
                    streamKey,
                    kind: 'flow.closed',
                    reasonCode: envelope.message.control.reasonCode ?? 'stream_stopped',
                });
            }
            return;
        }

        if (envelope.message.kind === 'sideband_control') {
            const streamKey = buildStreamKey({
                sourceMachineId: envelope.sourceMachineId,
                targetMachineId: envelope.targetMachineId,
                streamId: envelope.message.control.streamId,
            });
            const state = streamStateByKey.get(streamKey);
            if (state && (state.encryptionMode === 'plain') !== (envelope.message.control.payload.t === 'plain')) {
                emitError(socket, 'stream_payload_mode_mismatch');
                return;
            }
            if (!state && socketViewerId) {
                emitError(socket, 'live_stream_start_required');
                return;
            }
            if (!isTargetControlSocket) {
                emitError(socket, 'target_machine_control_required');
                return;
            }
            if (!state) {
                emitError(socket, 'live_stream_start_required');
                return;
            }
            const access = state.startRequest.authorization?.payload;
            if (access?.v === 2 && access.sessionBrowserAccess
                && !access.sessionBrowserAccess.effectiveAccess.capabilities.submitAgentInput
                && envelope.message.control.payload.t === 'plain'
                && machineLiveStreamControlRequiresInputLeaseV1(envelope.message.control.payload.v)) {
                emitError(socket, 'capture_source_denied');
                return;
            }
            const nowMs = ctx.nowMs?.() ?? Date.now();
            if (isRelayStateExpired(state, nowMs)) {
                closeExpiredState(streamKey, state);
                emitError(socket, 'live_stream_authorization_expired');
                return;
            }
            emitToMachine({
                io: ctx.io,
                machineId: envelope.sourceMachineId,
                envelope,
            });
            return;
        }
    };

    socket.on(MACHINE_LIVE_STREAM_SOCKET_EVENT, async (raw: unknown) => {
        if (!readMachineId(socket) && !isUserScopedSocket(socket)) {
            emitError(socket, 'machine_scoped_socket_required');
            return;
        }
        const parsed = MachineLiveStreamRelayEnvelopeV1Schema.safeParse(raw);
        if (!parsed.success) { emitError(socket, 'invalid_live_stream_payload'); return; }
        let envelope: MachineLiveStreamRelayEnvelopeV1;
        if (parsed.data.message.kind === 'receipt') {
            const parsedReceipt = MachineLiveStreamReceiptV1Schema.safeParse(parsed.data.message.receipt);
            if (!parsedReceipt.success) { emitError(socket, 'invalid_live_stream_payload'); return; }
            envelope = { ...parsed.data, message: { kind: 'receipt', receipt: parsedReceipt.data } };
        } else envelope = { ...parsed.data, message: parsed.data.message };
        const streamId = readEnvelopeStreamId(envelope);
        if (!streamId) { emitError(socket, 'invalid_live_stream_payload'); return; }
        const streamKey = buildStreamKey({ sourceMachineId: envelope.sourceMachineId, targetMachineId: envelope.targetMachineId, streamId });
        // Preserve arrival order behind asynchronous admission. Once admitted,
        // synchronous frames and controls need no serial promise work.
        const previous = pendingStartAdmissionsByKey.get(streamKey);
        const operation = previous
            ? previous.then(() => handleEnvelope(envelope, streamId))
            : handleEnvelope(envelope, streamId);
        if (!operation) return;
        pendingStartAdmissionsByKey.set(streamKey, operation);
        try { await operation; }
        finally { if (pendingStartAdmissionsByKey.get(streamKey) === operation) pendingStartAdmissionsByKey.delete(streamKey); }
    });

    socket.on('disconnect', () => {
        disconnected = true;
        releaseMachineAccessLoss?.();
        const viewerSocketId = isUserScopedSocket(socket) ? socket.id : '';
        if (viewerSocketId) closeStreamsForViewerSocket(viewerSocketId);
        for (const streamKey of socketStreamKeys) {
            const state = streamStateByKey.get(streamKey);
            if (state?.viewerSocketId) {
                emitToConsumer({
                    io: ctx.io,
                    userId,
                    sourceMachineId: state.sourceMachineId,
                    targetMachineId: state.targetMachineId,
                    viewerSocketId: state.viewerSocketId,
                    envelope: createStateStopControlEnvelope(state, 'socket_disconnected'),
                });
            }
            closeStreamWithObservability({
                streamKey,
                kind: 'flow.aborted',
                reasonCode: 'socket_disconnected',
            });
        }
        socketStreamKeys.clear();
    });
}
