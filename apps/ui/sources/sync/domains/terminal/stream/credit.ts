import type { TerminalRendererAck } from './model';

export type TerminalStreamCreditState = Readonly<{
    terminalId: string;
    rendererId: string;
    surfaceEpoch: number;
    ackedByteOffset: number;
    creditBytes: number;
}>;

export type TerminalStreamAckRejectReason =
    | 'terminal_mismatch'
    | 'renderer_mismatch'
    | 'stale_epoch'
    | 'stale_offset';

export type TerminalStreamAckResult = Readonly<{
    accepted: boolean;
    reason: TerminalStreamAckRejectReason | null;
    state: TerminalStreamCreditState;
}>;

export function createTerminalStreamCreditState(input: TerminalStreamCreditState): TerminalStreamCreditState {
    return {
        terminalId: input.terminalId,
        rendererId: input.rendererId,
        surfaceEpoch: Math.max(0, Math.trunc(input.surfaceEpoch)),
        ackedByteOffset: Math.max(0, Math.trunc(input.ackedByteOffset)),
        creditBytes: Math.max(0, Math.trunc(input.creditBytes)),
    };
}

export function applyTerminalRendererAck(
    state: TerminalStreamCreditState,
    ack: TerminalRendererAck,
): TerminalStreamAckResult {
    if (ack.terminalId !== state.terminalId) {
        return { accepted: false, reason: 'terminal_mismatch', state };
    }
    if (ack.rendererId !== state.rendererId) {
        return { accepted: false, reason: 'renderer_mismatch', state };
    }
    if (ack.surfaceEpoch < state.surfaceEpoch) {
        return { accepted: false, reason: 'stale_epoch', state };
    }
    if (ack.ackedByteOffset < state.ackedByteOffset) {
        return { accepted: false, reason: 'stale_offset', state };
    }

    return {
        accepted: true,
        reason: null,
        state: createTerminalStreamCreditState({
            terminalId: state.terminalId,
            rendererId: state.rendererId,
            surfaceEpoch: ack.surfaceEpoch,
            ackedByteOffset: ack.ackedByteOffset,
            creditBytes: ack.creditBytes,
        }),
    };
}
