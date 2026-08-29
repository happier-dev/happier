/** Binary stream session: one TCP connection per tunnel, instantiated per substream by the mux. */
import {
    PEER_TCP_TUNNEL_ACK_AFTER_BYTES,
    PEER_TCP_TUNNEL_ACK_AFTER_MS,
    type PeerTcpTunnelDirectionV1,
} from '@happier-dev/protocol';
import { isSchedulableTimeoutMs, parsePeerTcpTunnelFrame } from './primitives.js';
import { createPeerTcpTunnelFrameAccounting } from './flowAccounting.js';
import type { PeerTcpTunnelFrame, PeerTcpTunnelStreamConnection, PeerTcpTunnelStreamSessionResult, PeerTcpTunnelStreamSessionFailure } from './types.js';

type SendCreditState = {
    nextSequence: number;
    acknowledgedSequence: number;
    windowBytes: number;
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
    initialWindowBytes: number;
    maxFrameBytes: number;
    maxEncodedFrameBytes?: number;
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
}>) {
    const nowMs = input.nowMs ?? Date.now;
    const accounting = createPeerTcpTunnelFrameAccounting({
        initialWindowBytes: input.initialWindowBytes,
        nowMs,
    });
    const maxEncodedFrameBytes = input.maxEncodedFrameBytes ?? input.maxFrameBytes;
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
    let daemonToClientSequence = 0;
    let closed = false;
    let daemonToClientHalfClosed = false;
    let daemonReadPaused = false;
    let drainingDaemonQueue = false;
    const pendingDaemonChunks: Uint8Array[] = [];
    const ackTimers: Partial<Record<PeerTcpTunnelDirectionV1, ReturnType<typeof setTimeout>>> = {};
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let durationTimer: ReturnType<typeof setTimeout> | undefined;

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

    async function sendAbort(reasonCode: string): Promise<void> {
        await input.sendFrame(abortFrame(input.tunnelId, reasonCode));
    }

    async function abortAndClose(reasonCode: string): Promise<void> {
        if (!closed) {
            closed = true;
            clearAckTimers();
            clearLifecycleTimers();
            pendingDaemonChunks.length = 0;
            await sendAbort(reasonCode);
            detachConnectionData?.();
            await input.connection.close();
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
            void abortAndClose('max_idle_exceeded');
        }, input.maxIdleMs);
        idleTimer.unref?.();
    }

    function scheduleDurationTimer(): void {
        if (!isSchedulableTimeoutMs(input.maxDurationMs) || closed) return;
        durationTimer = setTimeout(() => {
            void abortAndClose('max_duration_exceeded');
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
        state.acknowledgedSequence = frame.nextSequence;
        state.windowBytes = frame.windowBytes;
        lastActivityMs = nowMs();
        scheduleIdleTimer();
        return { ok: true };
    }

    async function sendPendingAck(direction: PeerTcpTunnelDirectionV1): Promise<void> {
        if (closed) return;
        clearAckTimer(direction);
        const ack = accounting.flushPendingAck({ direction });
        await input.sendFrame({
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
            void sendPendingAck(direction);
        }, delayMs);
    }

    async function pauseDaemonReads(): Promise<void> {
        if (daemonReadPaused || closed) return;
        daemonReadPaused = true;
        await input.connection.pauseRead?.();
    }

    async function resumeDaemonReads(): Promise<void> {
        if (!daemonReadPaused || closed || daemonToClientHalfClosed || pendingDaemonChunks.length > 0) return;
        daemonReadPaused = false;
        await input.connection.resumeRead?.();
    }

    function queueDaemonData(bytes: Uint8Array): void {
        for (let offset = 0; offset < bytes.byteLength; offset += maxSendChunkBytes) {
            pendingDaemonChunks.push(bytes.subarray(offset, offset + maxSendChunkBytes));
        }
    }

    async function sendDaemonDataFrame(bytes: Uint8Array): Promise<void> {
        const lifecycleDeny = lifecycleDenyReason(bytes.byteLength);
        if (lifecycleDeny) {
            await abortAndClose(lifecycleDeny.reasonCode);
            return;
        }
        const frame: Extract<PeerTcpTunnelFrame, { kind: 'data' }> = {
            v: 1,
            kind: 'data',
            tunnelId: input.tunnelId,
            direction: 'daemon_to_client',
            sequence: daemonToClientSequence,
            payload: bytes,
        };
        if (bytes.byteLength > maxDecodedPayloadBytes) {
            await abortAndClose('decoded_payload_too_large');
            return;
        }
        daemonToClientSequence += bytes.byteLength;
        sendCredit.daemon_to_client.nextSequence += bytes.byteLength;
        recordActivity(bytes.byteLength);
        await input.sendFrame(frame);
    }

    async function drainDaemonQueue(): Promise<void> {
        if (drainingDaemonQueue) return;
        drainingDaemonQueue = true;
        try {
            while (!closed && !daemonToClientHalfClosed && pendingDaemonChunks.length > 0) {
                const next = pendingDaemonChunks[0]!;
                if (next.byteLength > availableSendWindow('daemon_to_client')) {
                    await pauseDaemonReads();
                    return;
                }
                pendingDaemonChunks.shift();
                await sendDaemonDataFrame(next);
            }
            await resumeDaemonReads();
        } finally {
            drainingDaemonQueue = false;
        }
    }

    async function enqueueDaemonData(bytes: Uint8Array): Promise<void> {
        if (closed || daemonToClientHalfClosed || bytes.byteLength === 0) return;
        queueDaemonData(bytes);
        await drainDaemonQueue();
    }

    let detachConnectionData: (() => void) | void;
    detachConnectionData = input.connection.onData?.((bytes) => {
        return enqueueDaemonData(bytes);
    });

    async function closeConnection(): Promise<void> {
        if (closed) return;
        closed = true;
        clearAckTimers();
        clearLifecycleTimers();
        pendingDaemonChunks.length = 0;
        detachConnectionData?.();
        await input.connection.close();
    }

    scheduleIdleTimer();
    scheduleDurationTimer();

    return {
        async acceptFrame(raw: unknown): Promise<PeerTcpTunnelStreamSessionResult> {
            const frame = parsePeerTcpTunnelFrame(raw);
            if (!frame) {
                await sendAbort('frame_invalid');
                return { ok: false, reasonCode: 'frame_invalid' };
            }
            if (frame.tunnelId !== input.tunnelId) {
                await sendAbort('tunnel_id_mismatch');
                return { ok: false, reasonCode: 'tunnel_id_mismatch' };
            }

            if (frame.kind === 'data') {
                if (frame.direction !== 'client_to_daemon') {
                    await sendAbort('direction_not_allowed');
                    return { ok: false, reasonCode: 'direction_not_allowed' };
                }

                if (frame.payload.byteLength > maxDecodedPayloadBytes) {
                    await sendAbort('decoded_payload_too_large');
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
                    await sendAbort(accepted.reasonCode);
                    return accepted;
                }

                if (frame.direction === 'client_to_daemon') {
                    await input.connection.write?.(frame.payload);
                    recordActivity(frame.payload.byteLength);
                    const pendingAck = accounting.recordPendingAck({
                        direction: frame.direction,
                        decodedBytes: frame.payload.byteLength,
                    });
                    if (pendingAck.pendingAckBytes >= ackAfterBytes || pendingAck.elapsedMs >= ackAfterMs) {
                        await sendPendingAck(frame.direction);
                    } else {
                        schedulePendingAck(frame.direction, pendingAck.elapsedMs);
                    }
                }

                return { ok: true };
            }

            if (frame.kind === 'ack') {
                const ack = applyAckFrame(frame);
                if (!ack.ok) {
                    await sendAbort(ack.reasonCode);
                }
                if (ack.ok && frame.direction === 'daemon_to_client') {
                    await drainDaemonQueue();
                }
                return ack;
            }

            if (frame.kind === 'close') {
                if (frame.halfClose && frame.direction) {
                    accounting.markHalfClosed({ direction: frame.direction });
                    if (frame.direction === 'client_to_daemon') {
                        await input.connection.endWrite?.();
                    } else {
                        daemonToClientHalfClosed = true;
                        pendingDaemonChunks.length = 0;
                        await pauseDaemonReads();
                    }
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
        close: closeConnection,
    };
}
