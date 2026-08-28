import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';

import type { TerminalRendererAck } from './model';

function ack(ackedByteOffset: number): TerminalRendererAck {
    return {
        terminalId: 'terminal-1',
        rendererId: 'embedded-terminal',
        surfaceEpoch: 4,
        ackedByteOffset,
        creditBytes: 1024,
    };
}

describe('terminal renderer ACK delivery', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('coalesces a failed in-flight ACK to the latest accepted byte offset before retrying', async () => {
        let rejectFirst!: (error: unknown) => void;
        const firstSend = new Promise<void>((_resolve, reject) => {
            rejectFirst = reject;
        });
        const send = vi.fn()
            .mockReturnValueOnce(firstSend)
            .mockResolvedValueOnce(undefined);
        const onDiagnostic = vi.fn();
        const { createTerminalRendererAckDelivery } = await import('./ackDelivery');
        const delivery = createTerminalRendererAckDelivery({ send, onDiagnostic });

        delivery.enqueue(ack(3));
        delivery.enqueue(ack(8));
        rejectFirst(Object.assign(new Error('temporary failure'), { rpcErrorCode: 'RPC_ACK_FAILED' }));
        await Promise.resolve();
        await Promise.resolve();

        expect(send).toHaveBeenCalledTimes(1);
        expect(onDiagnostic).toHaveBeenCalledWith({
            kind: 'retry-scheduled',
            errorCode: 'RPC_ACK_FAILED',
            retryAttempt: 1,
        });

        await vi.advanceTimersByTimeAsync(250);

        expect(send).toHaveBeenCalledTimes(2);
        expect(send.mock.calls[1]?.[0]).toEqual(expect.objectContaining({ ackedByteOffset: 8 }));
        delivery.dispose();
    });

    it.each([
        ['predecessor daemon', Object.assign(new Error('missing method'), { rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND }), 'RPC_METHOD_NOT_FOUND'],
        ['closed terminal', Object.assign(new Error('closed terminal'), { code: 'terminal_not_found' }), 'terminal_not_found'],
    ])('suppresses obsolete ACK delivery for a %s without retrying', async (_label, error, errorCode) => {
        const send = vi.fn().mockRejectedValue(error);
        const onDiagnostic = vi.fn();
        const { createTerminalRendererAckDelivery } = await import('./ackDelivery');
        const delivery = createTerminalRendererAckDelivery({ send, onDiagnostic });

        delivery.enqueue(ack(3));
        await Promise.resolve();
        await Promise.resolve();
        delivery.enqueue(ack(8));
        await vi.runAllTimersAsync();

        expect(send).toHaveBeenCalledTimes(1);
        expect(onDiagnostic).toHaveBeenCalledWith({
            kind: 'delivery-suppressed',
            errorCode,
        });
        delivery.dispose();
    });

    it('abandons a persistently failing ACK after the bounded retry budget', async () => {
        const send = vi.fn().mockRejectedValue(new Error('offline'));
        const onDiagnostic = vi.fn();
        const { createTerminalRendererAckDelivery, TERMINAL_RENDERER_ACK_MAX_RETRY_ATTEMPTS } = await import('./ackDelivery');
        const delivery = createTerminalRendererAckDelivery({ send, onDiagnostic });

        delivery.enqueue(ack(3));
        await vi.runAllTimersAsync();

        expect(send).toHaveBeenCalledTimes(1 + TERMINAL_RENDERER_ACK_MAX_RETRY_ATTEMPTS);
        expect(onDiagnostic).toHaveBeenLastCalledWith({
            kind: 'delivery-abandoned',
            errorCode: 'terminal_ack_delivery_failed',
            retryAttempts: TERMINAL_RENDERER_ACK_MAX_RETRY_ATTEMPTS,
        });
        delivery.dispose();
    });
});
