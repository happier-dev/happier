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

    it('returns object ACK response and does not fallback', async () => {
        const ackPayload = { ok: true, acceptedAt: 123 };
        const emitWithAck = vi.fn(async () => ackPayload);
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

        expect(ack).toEqual(ackPayload);
        expect(send).not.toHaveBeenCalled();
        expect(onNoAck).not.toHaveBeenCalled();
    });

    it('falls back when ACK is a primitive instead of an object', async () => {
        const emitWithAck = vi.fn(async () => 'ok');
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
        expect(send).toHaveBeenCalledTimes(1);
        expect(onNoAck).toHaveBeenCalledTimes(1);
    });
});
