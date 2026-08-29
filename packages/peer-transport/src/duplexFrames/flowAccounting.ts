/** Per-direction flow accounting: receive window, credit and ack cadence. */
import {
    type PeerTcpTunnelDirectionV1,
} from '@happier-dev/protocol';

type DirectionState = {
    nextSequence: number;
    windowBytes: number;
    halfClosed: boolean;
    pendingAckBytes: number;
    lastAckMs: number;
};


type FrameAccountingResult =
    | Readonly<{ ok: true; nextSequence: number; windowBytes: number }>
    | Readonly<{ ok: false; reasonCode: 'direction_half_closed' | 'sequence_mismatch' | 'receive_window_exceeded' }>;


function createDirectionState(initialWindowBytes: number): DirectionState {
    return {
        nextSequence: 0,
        windowBytes: initialWindowBytes,
        halfClosed: false,
        pendingAckBytes: 0,
        lastAckMs: 0,
    };
}

export function createPeerTcpTunnelFrameAccounting(input: Readonly<{
    initialWindowBytes: number;
    nowMs?: () => number;
}>) {
    const initialWindowBytes = Math.max(0, Math.floor(input.initialWindowBytes));
    const nowMs = input.nowMs ?? Date.now;
    const state: Record<PeerTcpTunnelDirectionV1, DirectionState> = {
        client_to_daemon: createDirectionState(initialWindowBytes),
        daemon_to_client: createDirectionState(initialWindowBytes),
    };
    state.client_to_daemon.lastAckMs = nowMs();
    state.daemon_to_client.lastAckMs = nowMs();

    return {
        acceptData(input: Readonly<{
            direction: PeerTcpTunnelDirectionV1;
            sequence: number;
            decodedBytes: number;
        }>): FrameAccountingResult {
            const direction = state[input.direction];
            if (direction.halfClosed) return { ok: false, reasonCode: 'direction_half_closed' };
            if (input.sequence !== direction.nextSequence) return { ok: false, reasonCode: 'sequence_mismatch' };

            const decodedBytes = Math.max(0, Math.floor(input.decodedBytes));
            if (decodedBytes > direction.windowBytes) return { ok: false, reasonCode: 'receive_window_exceeded' };

            direction.nextSequence += decodedBytes;
            direction.windowBytes -= decodedBytes;
            return {
                ok: true,
                nextSequence: direction.nextSequence,
                windowBytes: direction.windowBytes,
            };
        },
        ackConsumed(input: Readonly<{
            direction: PeerTcpTunnelDirectionV1;
            decodedBytes: number;
        }>): Readonly<{ ok: true; nextSequence: number; windowBytes: number }> {
            const direction = state[input.direction];
            const decodedBytes = Math.max(0, Math.floor(input.decodedBytes));
            direction.windowBytes = Math.min(initialWindowBytes, direction.windowBytes + decodedBytes);
            return {
                ok: true,
                nextSequence: direction.nextSequence,
                windowBytes: direction.windowBytes,
            };
        },
        recordPendingAck(input: Readonly<{
            direction: PeerTcpTunnelDirectionV1;
            decodedBytes: number;
        }>): Readonly<{ pendingAckBytes: number; elapsedMs: number }> {
            const direction = state[input.direction];
            direction.pendingAckBytes += Math.max(0, Math.floor(input.decodedBytes));
            return {
                pendingAckBytes: direction.pendingAckBytes,
                elapsedMs: nowMs() - direction.lastAckMs,
            };
        },
        flushPendingAck(input: Readonly<{
            direction: PeerTcpTunnelDirectionV1;
        }>): Readonly<{ ok: true; nextSequence: number; windowBytes: number }> {
            const direction = state[input.direction];
            direction.windowBytes = Math.min(initialWindowBytes, direction.windowBytes + direction.pendingAckBytes);
            const ack = {
                ok: true as const,
                nextSequence: direction.nextSequence,
                windowBytes: direction.windowBytes,
            };
            direction.pendingAckBytes = 0;
            direction.lastAckMs = nowMs();
            return ack;
        },
        markHalfClosed(input: Readonly<{ direction: PeerTcpTunnelDirectionV1 }>): Readonly<{ ok: true }> {
            state[input.direction].halfClosed = true;
            return { ok: true };
        },
    };
}
