import {
    MACHINE_LIVE_STREAM_SOCKET_EVENT,
    MachineLiveStreamRelayEnvelopeV1Schema,
    MachineLiveStreamReceiptV1Schema,
    PEER_MEDIATION_RECEIPTS,
    createMachineLiveStreamRelayAuthorizationSigningInputV1,
    getMachineLiveStreamPayloadDecodedByteLength,
    isMachineLiveStreamTerminalReceiptV1,
    type MachineLiveStreamControlV1,
    type MachineLiveStreamReceiptV1,
    type MachineLiveStreamWireFrameV1 as MachineLiveStreamFrameV1,
    type MachineLiveStreamRelayCaps,
    type MachineLiveStreamWireEnvelopeV1 as MachineLiveStreamRelayEnvelopeV1,
    type MachineLiveStreamStartRequestV1,
} from '@happier-dev/protocol';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import type { Server, Socket } from 'socket.io';
import tweetnacl from 'tweetnacl';
import { resolveSocketMaxHttpBufferSizeFromEnv } from './transportBudget';
import { getMachineInstallationSocketRoom } from '../socketRooms';
import { resolveMachineAdmission } from '@/app/machines/machineAccess';

import { resolveMachineLiveStreamRelayCaps } from '../../machines/peer/mediation/stream/relayCaps';
import { applyMachineLiveStreamRelayBackpressure } from '../../machines/peer/mediation/stream/metering';
import type { PeerMediationViewerSocketOwnershipVerifier } from './viewerSocketOwnership';
import {
    createPeerMediationFlowEvent,
    type PeerMediationObservabilityEmitter,
} from './peer/mediation/observability/events';

type MachineLiveStreamKey = string;

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
    lastBandwidthCappedReceiptAtMs: number | null;
    recentFrames: Array<Readonly<{ atMs: number; bytes: number }>>;
    queuedFrames: MachineLiveStreamFrameV1[];
    availableWindowFrames: number;
    availableWindowBytes: number;
    nextSequenceToRelay: number;
    lastAckNextSequence: number;
    awaitingKeyframe: boolean;
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

function buildStreamKey(input: Readonly<{
    userId: string;
    sourceMachineId: string;
    targetMachineId: string;
    streamId: string;
}>): MachineLiveStreamKey {
    return `${input.userId}:${input.sourceMachineId}:${input.targetMachineId}:${input.streamId}`;
}

function readMachineId(socket: Socket): string {
    const data = socket.data as { machineId?: unknown; clientType?: unknown };
    return data.clientType === 'machine-scoped' && typeof data.machineId === 'string' ? data.machineId : '';
}

function readEnvelopeStreamId(envelope: MachineLiveStreamRelayEnvelopeV1): string | null {
    const message = envelope.message;
    if (message.kind === 'start' || message.kind === 'renew') return message.startRequest.streamId;
    if (message.kind === 'frame') return message.frame.streamId;
    if (message.kind === 'receipt') {
        const receipt = MachineLiveStreamReceiptV1Schema.safeParse(message.receipt);
        return receipt.success ? receipt.data.streamId : null;
    }
    return message.control.streamId;
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
    socketMachineId: string;
    socketViewerId: string;
    envelope: MachineLiveStreamRelayEnvelopeV1;
    state: MachineLiveStreamRelayState | undefined;
}>): boolean {
    const state = input.state;
    if (!state) return isLegacyTargetMachineSocket(input);
    if (state.viewerSocketId) {
        return input.socketViewerId !== ''
            && input.socketViewerId === state.viewerSocketId
            && input.envelope.viewerSocketId === state.viewerSocketId;
    }
    return isLegacyTargetMachineSocket(input);
}

function emitError(socket: Socket, error: string): void {
    socket.emit(SOCKET_RPC_EVENTS.ERROR, {
        type: 'machine-live-stream',
        error,
    });
}

function emitToMachine(params: Readonly<{
    io: RelayIo;
    userId: string;
    machineId: string;
    envelope: MachineLiveStreamRelayEnvelopeV1;
}>): void {
    const streamId = readEnvelopeStreamId(params.envelope);
    if (!streamId) return;
    const state = streamStateByKey.get(buildStreamKey({ userId: params.userId,
        sourceMachineId: params.envelope.sourceMachineId, targetMachineId: params.envelope.targetMachineId, streamId }));
    if (!state) return;
    const installationId = params.machineId === state.sourceMachineId ? state.sourceMachineInstallationId
        : params.machineId === state.targetMachineId ? state.targetMachineInstallationId : null;
    if (!installationId) return;
    params.io.to(getMachineInstallationSocketRoom(params.userId, params.machineId, installationId)).emit(MACHINE_LIVE_STREAM_SOCKET_EVENT, params.envelope);
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
        userId: params.userId,
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
    return getMachineLiveStreamPayloadDecodedByteLength(frame.payload.t === 'plain' ? frame.payload.v : frame.payload.c);
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
        lastBandwidthCappedReceiptAtMs: null,
        recentFrames: [],
        queuedFrames: [],
        // Server relay owns the bounded viewer delivery window. It opens with one frame so a
        // newly started viewer can render a keyframe, then socket-authorized viewer acks
        // replenish the window in `applyAckControl`.
        availableWindowFrames: 1,
        availableWindowBytes: input.maxWindowBytes,
        nextSequenceToRelay: 1,
        lastAckNextSequence: 1,
        awaitingKeyframe: false,
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

function pruneRecentFrames(state: MachineLiveStreamRelayState, nowMs: number): void {
    const minMs = nowMs - 1_000;
    while (state.recentFrames.length > 0 && state.recentFrames[0]!.atMs < minMs) {
        state.recentFrames.shift();
    }
}

function resolveFrameCapFailure(input: Readonly<{
    state: MachineLiveStreamRelayState;
    frame: MachineLiveStreamFrameV1;
    caps: MachineLiveStreamRelayCaps;
    nowMs: number;
}>): string | null {
    const frameBytes = getFrameBytes(input.frame);
    if (input.caps.maxFrameBytes !== undefined && frameBytes > input.caps.maxFrameBytes) return 'max_frame_bytes_exceeded';
    if (input.caps.maxDurationMs !== undefined
        && input.nowMs - input.state.startedAtMs > input.caps.maxDurationMs) return 'max_duration_ms_exceeded';
    pruneRecentFrames(input.state, input.nowMs);
    const recentBytes = input.state.recentFrames.reduce((sum, item) => sum + item.bytes, 0) + frameBytes;
    const recentFrames = input.state.recentFrames.length + 1;
    if (input.caps.maxFramesPerSecond !== undefined && recentFrames > input.caps.maxFramesPerSecond) return 'max_frames_per_second_exceeded';
    if (input.caps.maxBitrateBps !== undefined && recentBytes * 8 > input.caps.maxBitrateBps) return 'max_bitrate_bps_exceeded';
    if (input.caps.maxTotalBytes !== undefined
        && input.state.bytesRelayed + frameBytes > input.caps.maxTotalBytes) return 'max_total_bytes_exceeded';
    return null;
}

function recordFrame(state: MachineLiveStreamRelayState, frame: MachineLiveStreamFrameV1, nowMs: number): void {
    const frameBytes = getFrameBytes(frame);
    state.bytesRelayed += frameBytes;
    state.framesRelayed += 1;
    state.recentFrames.push({ atMs: nowMs, bytes: frameBytes });
    pruneRecentFrames(state, nowMs);
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
        userId: input.userId,
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
    nowMs: number;
    trustRoots?: readonly RelayAuthorizationTrustRoot[];
}>): string | null {
    const authorization = input.startRequest.authorization;
    if (!authorization) return 'live_stream_authorization_required';
    const payload = authorization.payload;
    if (payload.exp <= input.nowMs) return 'live_stream_authorization_expired';
    if (payload.iat > input.nowMs) return 'live_stream_authorization_not_yet_valid';
    if (payload.accountId !== input.userId) return 'live_stream_authorization_mismatch';
    if (
        payload.sourceMachineId !== input.startRequest.sourceMachineId
        || payload.targetMachineId !== input.startRequest.targetMachineId
        || payload.flowKind !== 'live_stream'
        || payload.routeKind !== input.startRequest.routeKind
        || payload.streamId !== input.startRequest.streamId
        || payload.streamFamily !== input.startRequest.streamFamily
        || payload.sourceId !== input.startRequest.sourceId
        || payload.codecId !== input.startRequest.codecId
        || JSON.stringify(payload.viewerCodecs) !== JSON.stringify(input.startRequest.viewerCodecs)
        || payload.maxBitrateBps !== input.startRequest.maxBitrateBps
        || payload.maxFramesPerSecond !== input.startRequest.maxFramesPerSecond
        || payload.maxFrameBytes !== input.startRequest.maxFrameBytes
        || payload.maxDurationMs !== input.startRequest.maxDurationMs
        || payload.maxTotalBytes !== input.startRequest.maxTotalBytes
        // The viewer target is part of the signed grant: a daemon cannot re-point a grant
        // minted for one tab at a different viewer socket.
        || payload.viewerSocketId !== input.startRequest.viewerSocketId
    ) {
        return 'live_stream_authorization_mismatch';
    }
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
        userId: input.userId,
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
    nowMs: number;
}>): void {
    const capIntervalExceeded = input.state.lastBandwidthCappedReceiptAtMs === null
        || input.nowMs - input.state.lastBandwidthCappedReceiptAtMs >= 1_000;
    const pressured = applyMachineLiveStreamRelayBackpressure({
        streamId: input.state.streamId,
        routeKind: 'server_relay',
        frames: input.state.queuedFrames,
        maxWindowFrames: input.state.maxWindowFrames,
        maxWindowBytes: input.state.maxWindowBytes,
        capIntervalExceeded,
    });
    input.state.queuedFrames = [...pressured.frames];
    if (pressured.receipt) {
        input.state.lastBandwidthCappedReceiptAtMs = input.nowMs;
        input.state.framesDropped += pressured.receipt.framesDropped ?? 0;
        input.state.bytesDropped += pressured.receipt.bytesDropped ?? 0;
        emitReceipt({
            socket: input.socket,
            envelope: input.envelope,
            receipt: pressured.receipt,
        });
    }
    if (pressured.receipt && pressured.requiresKeyframeResync) {
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
    nowMs: number;
}>): void {
    if (input.state.awaitingKeyframe && input.frame.payloadKind === 'image_delta') {
        input.state.framesDropped += 1;
        input.state.bytesDropped += getFrameBytes(input.frame);
        emitKeyframeRequired(input);
        return;
    }
    if (input.frame.payloadKind === 'image_keyframe') {
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
    while (
        input.state.queuedFrames.length > 0
        && input.state.availableWindowFrames > 0
    ) {
        const nextFrame = input.state.queuedFrames[0]!;
        if (input.state.awaitingKeyframe && nextFrame.payloadKind !== 'image_keyframe') return;
        const frameBytes = getFrameBytes(nextFrame);
        if (frameBytes > input.state.availableWindowBytes) return;
        const capFailure = resolveFrameCapFailure({
            state: input.state,
            frame: nextFrame,
            caps: input.state.caps,
            nowMs: input.nowMs,
        });
        if (capFailure) {
            input.onCapFailure(nextFrame, capFailure);
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
        input.state.availableWindowFrames -= 1;
        input.state.availableWindowBytes -= frameBytes;
        recordFrame(input.state, nextFrame, input.nowMs);
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
        emitToMachine({ io: ctx.io, userId: state.userId, machineId: state.sourceMachineId, envelope });
        closeStreamWithObservability({ streamKey, kind: 'flow.errored', reasonCode: 'live_stream_authorization_expired' });
    };

    const closeStreamsForViewerSocket = (viewerSocketId: string): void => {
        for (const [streamKey, state] of [...streamStateByKey.entries()]) {
            if (state.userId !== userId || state.viewerSocketId !== viewerSocketId) continue;
            emitToMachine({
                io: ctx.io,
                userId,
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

    const handleEnvelope = async (envelope: MachineLiveStreamRelayEnvelopeV1): Promise<void> => {
        if (disconnected) return;
        const socketMachineId = readMachineId(socket);
        // C3: a per-tab viewer is a user-scoped browser socket (not machine-scoped). It may only
        // send consumer-side control (ack/stop/etc.) for a stream minted against its own socket id.
        const socketViewerId = isUserScopedSocket(socket) ? socket.id : '';
        if (!socketMachineId && !socketViewerId) {
            emitError(socket, 'machine_scoped_socket_required');
            return;
        }

        const isSourceSocket = socketMachineId !== '' && envelope.sourceMachineId === socketMachineId;
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

        if (ctx.serverRoutedLiveStreamEnabled !== true || !ctx.relayCaps) {
            emitError(socket, 'server_routed_live_stream_disabled');
            return;
        }

        let receipt: MachineLiveStreamReceiptV1 | undefined;
        if (envelope.message.kind !== 'start') {
            const message = envelope.message;
            let streamId: string;
            if (message.kind === 'receipt') {
                const parsedReceipt = MachineLiveStreamReceiptV1Schema.safeParse(message.receipt);
                if (!parsedReceipt.success) {
                    emitError(socket, 'invalid_live_stream_payload');
                    return;
                }
                receipt = parsedReceipt.data;
                streamId = receipt.streamId;
            } else if (message.kind === 'frame') {
                streamId = message.frame.streamId;
            } else if (message.kind === 'renew') {
                streamId = message.startRequest.streamId;
            } else if (message.kind === 'control' || message.kind === 'sideband_control') {
                streamId = message.control.streamId;
            } else {
                return;
            }
            const streamKey = buildStreamKey({ userId, sourceMachineId: envelope.sourceMachineId,
                targetMachineId: envelope.targetMachineId, streamId });
            const state = streamStateByKey.get(streamKey);
            if (state && !(await readCurrentInstallations(state.sourceMachineId, state.targetMachineId, state))) {
                const stop = createStateStopControlEnvelope(state, 'machine_unavailable');
                emitToConsumer({ io: ctx.io, userId, sourceMachineId: state.sourceMachineId,
                    targetMachineId: state.targetMachineId, viewerSocketId: state.viewerSocketId, envelope: stop });
                emitToMachine({ io: ctx.io, userId, machineId: state.sourceMachineId, envelope: stop });
                closeStreamWithObservability({ streamKey, kind: 'flow.errored', reasonCode: 'machine_unavailable' });
                emitError(socket, 'machine_unavailable');
                return;
            }
        }

        if (envelope.message.kind === 'start') {
            if (!isSourceSocket) {
                emitError(socket, 'source_machine_mismatch');
                return;
            }
            const { startRequest } = envelope.message;
            const serverCaps = ctx.relayCaps;
            const streamKey = buildStreamKey({
                userId,
                sourceMachineId: envelope.sourceMachineId,
                targetMachineId: envelope.targetMachineId,
                streamId: startRequest.streamId,
            });
            const admission = (async () => {
                let nowMs = ctx.nowMs?.() ?? Date.now();
                if (
                    startRequest.routeKind !== 'server_relay'
                    || startRequest.sourceMachineId !== envelope.sourceMachineId
                    || startRequest.targetMachineId !== envelope.targetMachineId
                ) {
                    emitError(socket, 'invalid_live_stream_start');
                    return;
                }
                const authorizationFailure = validateRelayAuthorization({
                    userId,
                    startRequest,
                    nowMs,
                    trustRoots: ctx.relayAuthorizationTrustRoots,
                });
                if (authorizationFailure) {
                    emitObservability({
                        streamId: startRequest.streamId,
                        sourceMachineId: envelope.sourceMachineId,
                        kind: 'flow.denied',
                        reasonCode: authorizationFailure,
                    });
                    emitError(socket, authorizationFailure);
                    return;
                }
                const viewerSocketId = startRequest.viewerSocketId ?? '';
                if (viewerSocketId) {
                    const viewerOwned = await ctx.verifyViewerSocketOwnership?.({
                        accountId: userId,
                        socketId: viewerSocketId,
                    });
                    if (viewerOwned !== true) {
                        emitObservability({
                            streamId: startRequest.streamId,
                            sourceMachineId: envelope.sourceMachineId,
                            kind: 'flow.denied',
                            reasonCode: 'viewer_socket_not_owned',
                        });
                        emitError(socket, 'viewer_socket_not_owned');
                        return;
                    }
                }
                const expiresAtMs = startRequest.authorization?.payload.exp;
                if (!expiresAtMs) {
                    emitObservability({
                        streamId: startRequest.streamId,
                        sourceMachineId: envelope.sourceMachineId,
                        kind: 'flow.denied',
                        reasonCode: 'live_stream_authorization_required',
                    });
                    emitError(socket, 'live_stream_authorization_required');
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
                    emitError(socket, capsFailure);
                    return;
                }

                let encryptionMode: 'plain' | 'e2ee' | null = null;
                try { encryptionMode = await ctx.resolveAccountEncryptionMode?.() ?? null; } catch { /* Fail closed. */ }
                if (disconnected) return;
                if (encryptionMode !== 'plain' && encryptionMode !== 'e2ee') {
                    emitError(socket, 'stream_encryption_mode_unavailable');
                    return;
                }
                const installations = await readCurrentInstallations(envelope.sourceMachineId, envelope.targetMachineId, streamStateByKey.get(streamKey));
                if (!installations || disconnected) {
                    emitError(socket, 'machine_unavailable');
                    return;
                }
                // Ownership and Account reads can outlive the signed admission window.
                // Re-sample at the synchronous state/resource admission boundary.
                nowMs = ctx.nowMs?.() ?? Date.now();
                if (expiresAtMs <= nowMs) {
                    emitObservability({ streamId: startRequest.streamId, sourceMachineId: envelope.sourceMachineId,
                        kind: 'flow.denied', reasonCode: 'live_stream_authorization_expired' });
                    emitError(socket, 'live_stream_authorization_expired');
                    return;
                }

                for (const [expiredKey, expiredState] of streamStateByKey) {
                    if (isRelayStateExpired(expiredState, nowMs)) closeExpiredState(expiredKey, expiredState);
                }
                pruneInactiveSocketStreamKeys(socketStreamKeys);
                const existingState = streamStateByKey.get(streamKey);
                if (existingState && isRelayStateExpired(existingState, nowMs)) {
                    removeStream(streamKey);
                }
                const currentState = streamStateByKey.get(streamKey);
                if (currentState && currentState.viewerSocketId !== viewerSocketId) {
                    emitObservability({
                        streamId: startRequest.streamId,
                        sourceMachineId: envelope.sourceMachineId,
                        kind: 'flow.denied',
                        reasonCode: 'live_stream_viewer_mismatch',
                    });
                    emitError(socket, 'live_stream_viewer_mismatch');
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
                        emitError(socket, concurrencyFailure);
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
            await admission;
            return;
        }

        if (envelope.message.kind === 'renew') {
            const { startRequest } = envelope.message;
            const streamKey = buildStreamKey({
                userId,
                sourceMachineId: envelope.sourceMachineId,
                targetMachineId: envelope.targetMachineId,
                streamId: startRequest.streamId,
            });
            const state = streamStateByKey.get(streamKey);
            if (!state) {
                emitError(socket, 'live_stream_start_required');
                return;
            }
            if (!isSourceSocket && !isConsumerControlSocketForState({ socketMachineId, socketViewerId, envelope, state })) {
                emitError(socket, 'target_machine_control_required');
                return;
            }
            const nowMs = ctx.nowMs?.() ?? Date.now();
            const authorizationFailure = validateRelayAuthorization({
                userId, startRequest, nowMs, trustRoots: ctx.relayAuthorizationTrustRoots,
            });
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
            if (!isSourceSocket) emitToMachine({ io: ctx.io, userId, machineId: state.sourceMachineId, envelope });
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
                userId,
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
            const capFailure = resolveFrameCapFailure({
                state,
                frame: envelope.message.frame,
                caps: state.caps,
                nowMs,
            });
            if (capFailure) {
                closeCapExceeded(streamKey, state, envelope.message.frame, capFailure);
                return;
            }
            enqueueRelayFrame({
                socket,
                io: ctx.io,
                userId,
                state,
                envelope,
                frame: envelope.message.frame,
                nowMs,
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

        if (receipt) {
            if (!isSourceSocket || receipt.routeKind !== 'server_relay') {
                emitError(socket, 'source_machine_mismatch');
                return;
            }
            const streamKey = buildStreamKey({
                userId,
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
                userId,
                sourceMachineId: envelope.sourceMachineId,
                targetMachineId: envelope.targetMachineId,
                streamId: envelope.message.control.streamId,
            });
            const state = streamStateByKey.get(streamKey);
            const isTargetControlSocket = isConsumerControlSocketForState({
                socketMachineId,
                socketViewerId,
                envelope,
                state,
            });
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
            if (envelope.message.control.kind === 'stop') {
                closeStreamWithObservability({
                    streamKey,
                    kind: 'flow.closed',
                    reasonCode: envelope.message.control.reasonCode ?? 'stream_stopped',
                });
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
                    userId,
                    machineId: envelope.sourceMachineId,
                    envelope,
                });
            }
            return;
        }

        if (envelope.message.kind === 'sideband_control') {
            const streamKey = buildStreamKey({
                userId,
                sourceMachineId: envelope.sourceMachineId,
                targetMachineId: envelope.targetMachineId,
                streamId: envelope.message.control.streamId,
            });
            const state = streamStateByKey.get(streamKey);
            if (state && (state.encryptionMode === 'plain') !== (envelope.message.control.payload.t === 'plain')) {
                emitError(socket, 'stream_payload_mode_mismatch');
                return;
            }
            const isTargetControlSocket = isConsumerControlSocketForState({
                socketMachineId,
                socketViewerId,
                envelope,
                state,
            });
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
            const nowMs = ctx.nowMs?.() ?? Date.now();
            if (isRelayStateExpired(state, nowMs)) {
                closeExpiredState(streamKey, state);
                emitError(socket, 'live_stream_authorization_expired');
                return;
            }
            emitToMachine({
                io: ctx.io,
                userId,
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
        const envelope = parsed.data;
        const streamId = readEnvelopeStreamId(envelope);
        if (!streamId) { emitError(socket, 'invalid_live_stream_payload'); return; }
        const streamKey = buildStreamKey({ userId, sourceMachineId: envelope.sourceMachineId, targetMachineId: envelope.targetMachineId, streamId });
        // Current DB admission is asynchronous. Preserve the existing stream arrival
        // order across source frames and viewer controls while each effect is checked.
        const previous = pendingStartAdmissionsByKey.get(streamKey);
        const operation = (previous ?? Promise.resolve()).then(() => handleEnvelope(envelope));
        pendingStartAdmissionsByKey.set(streamKey, operation);
        try { await operation; }
        finally { if (pendingStartAdmissionsByKey.get(streamKey) === operation) pendingStartAdmissionsByKey.delete(streamKey); }
    });

    socket.on('disconnect', () => {
        disconnected = true;
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
