import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { describe, expect, it, vi } from 'vitest';

import { scopedSocketEmitWithAck } from './scopedSocketEmitWithAck';

describe('scopedSocketEmitWithAck', () => {
    it('emits one correlated relay cancellation when its caller aborts after issue', async () => {
        const emit = vi.fn();
        const emitWithAck = vi.fn(() => new Promise<never>(() => {}));
        const socket = {
            emit,
            timeout: vi.fn(() => ({ emitWithAck })),
        };
        const controller = new AbortController();

        const pending = scopedSocketEmitWithAck({
            socket,
            event: SOCKET_RPC_EVENTS.CALL,
            payload: { method: 'agent.run', params: {}, requestId: 'caller-request' },
            timeoutMs: 1_000,
            signal: controller.signal,
            requestId: 'caller-request',
        });
        await vi.waitFor(() => expect(emitWithAck).toHaveBeenCalledTimes(1));

        controller.abort();

        const settled = await Promise.race([
            pending.then(
                () => ({ status: 'resolved' as const }),
                (error: unknown) => ({ status: 'rejected' as const, error }),
            ),
            new Promise<{ status: 'pending' }>((resolve) => {
                setTimeout(() => resolve({ status: 'pending' }), 50);
            }),
        ]);
        expect(settled).toMatchObject({
            status: 'rejected',
            error: {
                name: 'AbortError',
                code: 'SOCKET_RPC_ABORTED',
            },
        });
        expect(emit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.CANCEL, {
            requestId: 'caller-request',
        });
    });
});
