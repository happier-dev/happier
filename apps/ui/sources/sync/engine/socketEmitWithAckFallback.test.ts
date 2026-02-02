import { describe, expect, it, vi } from 'vitest';

import { socketEmitWithAckFallback } from './socketEmitWithAckFallback';

describe('socketEmitWithAckFallback', () => {
    it('falls back to send + onNoAck when emitWithAck rejects (old server / missing ACK)', async () => {
        const emitWithAck = vi.fn(async () => {
            throw new Error('timeout');
        });
        const send = vi.fn();
        const onNoAck = vi.fn();

        const ack = await socketEmitWithAckFallback({
            emitWithAck,
            send,
            event: 'message',
            payload: { sid: 's1', message: 'enc', localId: 'l1' },
            timeoutMs: 7_500,
            onNoAck,
        });

        expect(ack).toBeNull();
        expect(emitWithAck).toHaveBeenCalledWith('message', { sid: 's1', message: 'enc', localId: 'l1' }, { timeoutMs: 7_500 });
        expect(send).toHaveBeenCalledWith('message', { sid: 's1', message: 'enc', localId: 'l1' });
        expect(onNoAck).toHaveBeenCalledTimes(1);
    });
});

