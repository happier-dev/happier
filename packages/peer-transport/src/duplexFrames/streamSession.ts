/** Binary stream session: one TCP connection per tunnel, instantiated per substream by the mux. */
import { PEER_TCP_TUNNEL_ACK_AFTER_BYTES, PEER_TCP_TUNNEL_ACK_AFTER_MS } from '@happier-dev/protocol/machines/peer/mediation/tunnel/v1';
import type { PeerTcpTunnelDirectionV1 } from '@happier-dev/protocol';
import { isSchedulableTimeoutMs, parsePeerTcpTunnelFrame } from './primitives.js';
import { createPeerTcpTunnelFrameAccounting } from './flowAccounting.js';
import type { PeerTcpTunnelFrame, PeerTcpTunnelStreamConnection, PeerTcpTunnelStreamSessionResult, PeerTcpTunnelStreamSessionFailure } from './types.js';

type SendCreditState = {
    nextSequence: number;
    acknowledgedSequence: number;
    windowBytes: number;
};

type PendingOutboundChunk = {
    bytes: Uint8Array;
    resolve?: (result: PeerTcpTunnelStreamSessionResult) => void;
};


function abortFrame(tunnelId: string, reasonCode: string): PeerTcpTunnelFrame {
    return {
        v: 1,
        kind: 'abort',
        tunnelId,
        reasonCode,
    };
}


export function createPeerTcpTunnelStreamSession(input: Readonly<{
    tunnelId: string;
    outboundDirection?: PeerTcpTunnelDirectionV1;
    initialWindowBytes: number;
    maxFrameBytes: number;
    maxDecodedPayloadBytes?: number;
    maxSendChunkBytes?: number;
    ackAfterBytes?: number;
    ackAfterMs?: number;
    maxIdleMs?: number;
    maxDurationMs?: number;
    maxTotalBytes?: number;
    nowMs?: () => number;
    connection: PeerTcpTunnelStreamConnection;
    sendFrame: (frame: PeerTcpTunnelFrame) => Promise<void> | void;
    onClosed?: () => void;
}>) {
    const outboundDirection = input.outboundDirection ?? 'daemon_to_client';
    const inboundDirection: PeerTcpTunnelDirectionV1 = outboundDirection === 'client_to_daemon'
        ? 'daemon_to_client'
        : 'client_to_daemon';
    const nowMs = input.nowMs ?? Date.now;
    const accounting = createPeerTcpTunnelFrameAccounting({
        initialWindowBytes: input.initialWindowBytes,
        nowMs,
    });
    const maxDecodedPayloadBytes = input.maxDecodedPayloadBytes ?? input.maxFrameBytes;
    const maxSendChunkBytes = input.maxSendChunkBytes ?? maxDecodedPayloadBytes;
    const sendCredit: Record<PeerTcpTunnelDirectionV1, SendCreditState> = {
        client_to_daemon: {
            nextSequence: 0,
            acknowledgedSequence: 0,
            windowBytes: input.initialWindowBytes,
        },
        daemon_to_client: {
            nextSequence: 0,
            acknowledgedSequence: 0,
            windowBytes: input.initialWindowBytes,
        },
    };
    const ackAfterBytes = Math.max(1, Math.floor(input.ackAfterBytes ?? PEER_TCP_TUNNEL_ACK_AFTER_BYTES));
    const ackAfterMs = Math.max(1, Math.floor(input.ackAfterMs ?? PEER_TCP_TUNNEL_ACK_AFTER_MS));
    const startedAtMs = nowMs();
    let lastActivityMs = startedAtMs;
    let totalBytes = 0;
    let outboundSequence = 0;
    let closed = false;
    let outboundEndRequested = false;
    let outboundHalfClosed = false;
    let outboundHalfCloseSent = false;
    let inboundHalfClosed = false;
    let outboundReadPaused = false;
    let drainingOutboundQueue = false;
    const pendingOutboundChunks: PendingOutboundChunk[] = [];
    let outboundChunkBeingHandedOff: PendingOutboundChunk | null = null;
    const ackTimers: Partial<Record<PeerTcpTunnelDirectionV1, ReturnType<typeof setTimeout>>> = {};
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let durationTimer: ReturnType<typeof setTimeout> | undefined;
    let localClosePromise: Promise<void> | null = null;
    let pendingOutboundHalfClose: Readonly<{
        reasonCode: string;
        resolve: (result: PeerTcpTunnelStreamSessionResult) => void;
    }> | null = null;
    const detachConnectionHandlers: (() => void)[] = [];

    function clearAckTimer(direction: PeerTcpTunnelDirectionV1): void {
        const timer = ackTimers[direction];
        if (timer) clearTimeout(timer);
        delete ackTimers[direction];
    }

    function clearAckTimers(): void {
        clearAckTimer('client_to_daemon');
        clearAckTimer('daemon_to_client');
    }

    function clearLifecycleTimers(): void {
        if (idleTimer) clearTimeout(idleTimer);
        if (durationTimer) clearTimeout(durationTimer);
        idleTimer = undefined;
        durationTimer = undefined;
    }

    function settlePendingOutboundChunks(reasonCode: PeerTcpTunnelStreamSessionFailure['reasonCode']): void {
        for (const pending of pendingOutboundChunks.splice(0)) {
            if (pending === outboundChunkBeingHandedOff) continue;
            pending.resolve?.({ ok: false, reasonCode });
        }
    }

    function settlePendingOutboundHalfClose(result: PeerTcpTunnelStreamSessionResult): void {
        const pending = pendingOutboundHalfClose;
        pendingOutboundHalfClose = null;
        pending?.resolve(result);
    }

    function closeLocally(
        pendingReasonCode: PeerTcpTunnelStreamSessionFailure['reasonCode'] = 'tunnel_closed',
    ): Promise<void> {
        if (localClosePromise) return localClosePromise;
        closed = true;
        clearAckTimers();
        clearLifecycleTimers();
        settlePendingOutboundChunks(pendingReasonCode);
        settlePendingOutboundHalfClose({ ok: false, reasonCode: pendingReasonCode });
        // Publish the shared close promise before notifying the enclosing owner:
        // its release path can re-enter session.close() without closing TCP twice.
        localClosePromise = Promise.resolve().then(async () => {
            let detachFailure: unknown;
            try {
                for (const detach of detachConnectionHandlers.splice(0)) detach();
                input.onClosed?.();
            } catch (error) {
                detachFailure = error;
            }
            let closeFailure: unknown;
            try {
                await input.connection.close();
            } catch (error) {
                closeFailure = error;
            }
            if (detachFailure !== undefined) throw detachFailure;
            if (closeFailure !== undefined) throw closeFailure;
        });
        return localClosePromise;
    }

    async function notifyPeerAndClose(
        frame: PeerTcpTunnelFrame,
        pendingReasonCode: PeerTcpTunnelStreamSessionFailure['reasonCode'] = 'tunnel_closed',
    ): Promise<void> {
        const localClose = closeLocally(pendingReasonCode);
        let notification: Promise<void>;
        try {
            notification = Promise.resolve(input.sendFrame(frame));
        } catch (error) {
            notification = Promise.reject(error);
        }
        const [notificationResult, closeResult] = await Promise.allSettled([notification, localClose]);
        if (notificationResult.status === 'rejected') throw notificationResult.reason;
        if (closeResult.status === 'rejected') throw closeResult.reason;
    }

    async function abortAndClose(
        reasonCode: string,
        propagateNotificationFailure = false,
        pendingReasonCode: PeerTcpTunnelStreamSessionFailure['reasonCode'] = 'tunnel_closed',
    ): Promise<void> {
        try {
            await notifyPeerAndClose(abortFrame(input.tunnelId, reasonCode), pendingReasonCode);
        } catch (error) {
            if (propagateNotificationFailure) throw error;
        }
    }

    async function failConnectionWrite(): Promise<PeerTcpTunnelStreamSessionFailure> {
        const failure = { ok: false as const, reasonCode: 'connection_write_failed' as const };
        await abortAndClose(failure.reasonCode, false, failure.reasonCode);
        return failure;
    }

    async function finishClosedDirections(): Promise<void> {
        if (inboundHalfClosed && outboundHalfCloseSent) await closeLocally();
    }

    async function sendSessionFrame(
        frame: PeerTcpTunnelFrame,
        onSendFrameReturned?: (completedSynchronously: boolean) => void,
    ): Promise<PeerTcpTunnelStreamSessionResult> {
        try {
            const send = input.sendFrame(frame);
            onSendFrameReturned?.(send === undefined);
            await send;
            return { ok: true };
        } catch {
            try {
                await closeLocally('frame_send_failed');
            } catch {
                // The typed send failure remains authoritative after local cleanup was attempted.
            }
            return { ok: false, reasonCode: 'frame_send_failed' };
        }
    }

    function lifecycleDenyReason(decodedBytes: number): PeerTcpTunnelStreamSessionFailure | null {
        if (closed) return { ok: false, reasonCode: 'tunnel_closed' };
        const now = nowMs();
        if (input.maxDurationMs !== undefined && now - startedAtMs > input.maxDurationMs) {
            return { ok: false, reasonCode: 'max_duration_exceeded' };
        }
        if (input.maxIdleMs !== undefined && now - lastActivityMs > input.maxIdleMs) {
            return { ok: false, reasonCode: 'max_idle_exceeded' };
        }
        if (input.maxTotalBytes !== undefined && totalBytes + decodedBytes > input.maxTotalBytes) {
            return { ok: false, reasonCode: 'total_bytes_exceeded' };
        }
        return null;
    }

    function recordActivity(decodedBytes: number): void {
        totalBytes += decodedBytes;
        lastActivityMs = nowMs();
        scheduleIdleTimer();
    }

    function scheduleIdleTimer(): void {
        if (!isSchedulableTimeoutMs(input.maxIdleMs) || closed) return;
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
            void abortAndClose('max_idle_exceeded').catch(() => undefined);
        }, input.maxIdleMs);
        idleTimer.unref?.();
    }

    function scheduleDurationTimer(): void {
        if (!isSchedulableTimeoutMs(input.maxDurationMs) || closed) return;
        durationTimer = setTimeout(() => {
            void abortAndClose('max_duration_exceeded').catch(() => undefined);
        }, input.maxDurationMs);
        durationTimer.unref?.();
    }

    function availableSendWindow(direction: PeerTcpTunnelDirectionV1): number {
        const state = sendCredit[direction];
        return Math.max(0, state.acknowledgedSequence + state.windowBytes - state.nextSequence);
    }

    function applyAckFrame(frame: Extract<PeerTcpTunnelFrame, { kind: 'ack' }>): PeerTcpTunnelStreamSessionResult {
        const state = sendCredit[frame.direction];
        if (frame.nextSequence < state.acknowledgedSequence || frame.nextSequence > state.nextSequence) {
            return { ok: false, reasonCode: 'ack_sequence_invalid' };
        }
        if (frame.windowBytes > input.initialWindowBytes) {
            return { ok: false, reasonCode: 'ack_window_invalid' };
        }
        state.acknowledgedSequence = frame.nextSequence;
        state.windowBytes = frame.windowBytes;
        lastActivityMs = nowMs();
        scheduleIdleTimer();
        return { ok: true };
    }

    async function sendPendingAck(direction: PeerTcpTunnelDirectionV1): Promise<PeerTcpTunnelStreamSessionResult> {
        if (closed) return { ok: false, reasonCode: 'tunnel_closed' };
        clearAckTimer(direction);
        const ack = accounting.flushPendingAck({ direction });
        return sendSessionFrame({
            v: 1,
            kind: 'ack',
            tunnelId: input.tunnelId,
            direction,
            nextSequence: ack.nextSequence,
            windowBytes: ack.windowBytes,
        });
    }

    function schedulePendingAck(direction: PeerTcpTunnelDirectionV1, elapsedMs: number): void {
        if (closed || ackTimers[direction]) return;
        const delayMs = Math.max(0, ackAfterMs - Math.max(0, elapsedMs));
        ackTimers[direction] = setTimeout(() => {
            void sendPendingAck(direction).catch(() => undefined);
        }, delayMs);
    }

    async function pauseOutboundReads(): Promise<void> {
        if (outboundReadPaused || closed) return;
        outboundReadPaused = true;
        await input.connection.pauseRead?.();
    }

    async function resumeOutboundReads(): Promise<void> {
        if (!outboundReadPaused || closed || outboundHalfClosed || pendingOutboundChunks.length > 0) return;
        outboundReadPaused = false;
        await input.connection.resumeRead?.();
    }

    function queueOutboundData(
        bytes: Uint8Array,
        resolve?: (result: PeerTcpTunnelStreamSessionResult) => void,
    ): void {
        const chunkBytes = Math.max(1, Math.min(maxSendChunkBytes, input.initialWindowBytes));
        const chunks: Uint8Array[] = [];
        for (let offset = 0; offset < bytes.byteLength; offset += chunkBytes) {
            chunks.push(bytes.subarray(offset, offset + chunkBytes));
        }
        let remaining = chunks.length;
        let settled = false;
        for (const chunk of chunks) {
            pendingOutboundChunks.push({
                bytes: chunk,
                ...(resolve ? {
                    resolve: (result) => {
                        if (settled) return;
                        if (!result.ok || --remaining === 0) {
                            settled = true;
                            resolve(result);
                        }
                    },
                } : {}),
            });
        }
    }

    async function sendOutboundDataFrame(
        bytes: Uint8Array,
        onSendFrameReturned: (completedSynchronously: boolean) => void,
    ): Promise<PeerTcpTunnelStreamSessionResult> {
        const lifecycleDeny = lifecycleDenyReason(bytes.byteLength);
        if (lifecycleDeny) {
            await abortAndClose(lifecycleDeny.reasonCode);
            return lifecycleDeny;
        }
        const frame: Extract<PeerTcpTunnelFrame, { kind: 'data' }> = {
            v: 1,
            kind: 'data',
            tunnelId: input.tunnelId,
            direction: outboundDirection,
            sequence: outboundSequence,
            payload: bytes,
        };
        if (bytes.byteLength > maxDecodedPayloadBytes) {
            await abortAndClose('decoded_payload_too_large');
            return { ok: false, reasonCode: 'decoded_payload_too_large' };
        }
        outboundSequence += bytes.byteLength;
        sendCredit[outboundDirection].nextSequence += bytes.byteLength;
        recordActivity(bytes.byteLength);
        return sendSessionFrame(frame, onSendFrameReturned);
    }

    async function drainOutboundQueue(): Promise<void> {
        if (drainingOutboundQueue) return;
        drainingOutboundQueue = true;
        try {
            while (!closed && !outboundHalfClosed && pendingOutboundChunks.length > 0) {
                const next = pendingOutboundChunks[0]!;
                if (next.bytes.byteLength > availableSendWindow(outboundDirection)) {
                    await pauseOutboundReads();
                    return;
                }
                outboundChunkBeingHandedOff = next;
                const sent = await sendOutboundDataFrame(next.bytes, (completedSynchronously) => {
                    outboundChunkBeingHandedOff = null;
                    if (completedSynchronously && pendingOutboundChunks[0] === next) {
                        pendingOutboundChunks.shift();
                    }
                });
                outboundChunkBeingHandedOff = null;
                if (pendingOutboundChunks[0] === next) pendingOutboundChunks.shift();
                next.resolve?.(sent);
                if (!sent.ok) return;
            }
            if (!closed && outboundEndRequested && !outboundHalfClosed && pendingOutboundChunks.length === 0) {
                outboundHalfClosed = true;
                accounting.markHalfClosed({ direction: outboundDirection });
                const reasonCode = pendingOutboundHalfClose?.reasonCode ?? 'direction_half_closed';
                const result = await sendSessionFrame({
                    v: 1,
                    kind: 'close',
                    tunnelId: input.tunnelId,
                    direction: outboundDirection,
                    halfClose: true,
                    reasonCode,
                });
                settlePendingOutboundHalfClose(result);
                if (result.ok) {
                    outboundHalfCloseSent = true;
                    await finishClosedDirections();
                }
                return;
            }
            await resumeOutboundReads();
        } finally {
            drainingOutboundQueue = false;
            // `endWrite()` can arrive while the final data frame is waiting on
            // an asynchronous read-resume. Give that newly requested close a
            // fresh drain pass after releasing the single-drainer guard.
            if (!closed && outboundEndRequested && !outboundHalfClosed && pendingOutboundChunks.length === 0) {
                void drainOutboundQueue();
            }
        }
    }

    async function enqueueOutboundData(bytes: Uint8Array): Promise<void> {
        if (closed || outboundEndRequested || outboundHalfClosed || bytes.byteLength === 0) return;
        queueOutboundData(bytes);
        await drainOutboundQueue();
    }

    const detachConnectionData = input.connection.onData?.((bytes) => {
        return enqueueOutboundData(bytes);
    });
    if (detachConnectionData) detachConnectionHandlers.push(detachConnectionData);
    const detachConnectionEnd = input.connection.onEnd?.(() => {
        if (closed || outboundEndRequested || outboundHalfClosed) return;
        outboundEndRequested = true;
        void drainOutboundQueue();
    });
    if (detachConnectionEnd) detachConnectionHandlers.push(detachConnectionEnd);
    const detachConnectionError = input.connection.onError?.(() => {
        if (!closed) void abortAndClose('connection_read_failed', false, 'connection_read_failed');
    });
    if (detachConnectionError) detachConnectionHandlers.push(detachConnectionError);
    const detachConnectionClose = input.connection.onClose?.(() => {
        // Native EOF may already be queued behind peer credit. Preserve that
        // directional drain after the socket itself has finished both halves.
        if (!closed && !(outboundEndRequested && inboundHalfClosed)) {
            void abortAndClose('connection_read_failed', false, 'connection_read_failed');
        }
    });
    if (detachConnectionClose) detachConnectionHandlers.push(detachConnectionClose);

    const closeConnection = (): Promise<void> => closeLocally();

    scheduleIdleTimer();
    scheduleDurationTimer();

    return {
        async acceptFrame(raw: unknown): Promise<PeerTcpTunnelStreamSessionResult> {
            if (closed) return { ok: false, reasonCode: 'tunnel_closed' };
            const frame = parsePeerTcpTunnelFrame(raw);
            if (!frame) {
                await abortAndClose('frame_invalid');
                return { ok: false, reasonCode: 'frame_invalid' };
            }
            if (frame.tunnelId !== input.tunnelId) {
                await abortAndClose('tunnel_id_mismatch');
                return { ok: false, reasonCode: 'tunnel_id_mismatch' };
            }

            if (frame.kind === 'data') {
                if (frame.direction !== inboundDirection) {
                    await abortAndClose('direction_not_allowed');
                    return { ok: false, reasonCode: 'direction_not_allowed' };
                }

                if (frame.payload.byteLength > maxDecodedPayloadBytes) {
                    await abortAndClose('decoded_payload_too_large');
                    return { ok: false, reasonCode: 'decoded_payload_too_large' };
                }

                const lifecycleDeny = lifecycleDenyReason(frame.payload.byteLength);
                if (lifecycleDeny) {
                    await abortAndClose(lifecycleDeny.reasonCode);
                    return lifecycleDeny;
                }

                const accepted = accounting.acceptData({
                    direction: frame.direction,
                    sequence: frame.sequence,
                    decodedBytes: frame.payload.byteLength,
                });
                if (!accepted.ok) {
                    await abortAndClose(accepted.reasonCode);
                    return accepted;
                }

                try {
                    await input.connection.write?.(frame.payload);
                } catch {
                    return failConnectionWrite();
                }
                recordActivity(frame.payload.byteLength);
                const pendingAck = accounting.recordPendingAck({
                    direction: frame.direction,
                    decodedBytes: frame.payload.byteLength,
                });
                if (pendingAck.pendingAckBytes >= ackAfterBytes || pendingAck.elapsedMs >= ackAfterMs) {
                    const sent = await sendPendingAck(frame.direction);
                    if (!sent.ok) return sent;
                } else {
                    schedulePendingAck(frame.direction, pendingAck.elapsedMs);
                }

                return { ok: true };
            }

            if (frame.kind === 'ack') {
                const ack = applyAckFrame(frame);
                if (!ack.ok) {
                    await abortAndClose(ack.reasonCode);
                }
                if (ack.ok && frame.direction === outboundDirection) {
                    await drainOutboundQueue();
                }
                return ack;
            }

            if (frame.kind === 'close') {
                if (frame.halfClose && frame.direction) {
                    accounting.markHalfClosed({ direction: frame.direction });
                    if (frame.direction === inboundDirection) {
                        inboundHalfClosed = true;
                        try {
                            await input.connection.endWrite?.();
                        } catch {
                            return failConnectionWrite();
                        }
                    } else {
                        outboundHalfClosed = true;
                        outboundHalfCloseSent = true;
                        for (const pending of pendingOutboundChunks.splice(0)) {
                            pending.resolve?.({ ok: false, reasonCode: 'direction_half_closed' });
                        }
                        settlePendingOutboundHalfClose({ ok: false, reasonCode: 'direction_half_closed' });
                        await pauseOutboundReads();
                    }
                    await finishClosedDirections();
                    return { ok: true };
                }
                await closeConnection();
                return { ok: true };
            }

            if (frame.kind === 'abort') {
                await closeConnection();
                return { ok: true };
            }

            return { ok: true };
        },
        async write(bytes: Uint8Array): Promise<PeerTcpTunnelStreamSessionResult> {
            if (closed) return { ok: false, reasonCode: 'tunnel_closed' };
            if (outboundEndRequested || outboundHalfClosed) return { ok: false, reasonCode: 'direction_half_closed' };
            if (bytes.byteLength === 0) return { ok: true };
            return new Promise((resolve) => {
                queueOutboundData(bytes, resolve);
                void drainOutboundQueue();
            });
        },
        async endWrite(reasonCode: string): Promise<PeerTcpTunnelStreamSessionResult> {
            if (closed) return { ok: false, reasonCode: 'tunnel_closed' };
            if (outboundEndRequested || outboundHalfClosed) return { ok: false, reasonCode: 'direction_half_closed' };
            outboundEndRequested = true;
            return new Promise((resolve) => {
                pendingOutboundHalfClose = { reasonCode, resolve };
                void drainOutboundQueue();
            });
        },
        async abort(reasonCode: string): Promise<void> {
            await abortAndClose(reasonCode, true);
        },
        async terminate(reasonCode: string): Promise<void> {
            if (closed) return;
            await notifyPeerAndClose({
                v: 1,
                kind: 'close',
                tunnelId: input.tunnelId,
                halfClose: false,
                reasonCode,
            });
        },
        close: closeConnection,
    };
}
