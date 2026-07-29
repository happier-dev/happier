import { describe, expect, it, vi } from 'vitest';

import { HappyError } from '@/utils/errors/errors';

import { socketEmitWithAckFallback } from './socketEmitWithAckFallback';

describe('socketEmitWithAckFallback', () => {
    it('falls back when the Socket.IO ACK promise never settles', async () => {
        vi.useFakeTimers();
        try {
            const emitWithAck = vi.fn(() => new Promise<never>(() => {}));
            const send = vi.fn();
            const onNoAck = vi.fn();

            const ackPromise = socketEmitWithAckFallback({
                emitWithAck,
                send,
                event: 'message',
                payload: { sid: 's1', message: 'enc', localId: 'l1' },
                timeoutMs: 7_500,
                onNoAck,
            });

            await vi.advanceTimersByTimeAsync(7_499);
            expect(send).not.toHaveBeenCalled();
            expect(onNoAck).not.toHaveBeenCalled();

            await vi.advanceTimersByTimeAsync(1);
            expect(send).toHaveBeenCalledWith('message', { sid: 's1', message: 'enc', localId: 'l1' });
            expect(onNoAck).toHaveBeenCalledTimes(1);
            await expect(ackPromise).resolves.toBeNull();
        } finally {
            vi.useRealTimers();
        }
    });

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

    it('rethrows auth failures instead of falling back to fire-and-forget send', async () => {
        const authError = new HappyError('Authentication required', false, {
            kind: 'auth',
            code: 'not_authenticated',
        });
        const emitWithAck = vi.fn(async () => {
            throw authError;
        });
        const send = vi.fn();
        const onNoAck = vi.fn();

        await expect(socketEmitWithAckFallback({
            emitWithAck,
            send,
            event: 'message',
            payload: { sid: 's1', message: 'enc', localId: 'l1' },
            timeoutMs: 7_500,
            onNoAck,
        })).rejects.toMatchObject({
            name: 'HappyError',
            kind: 'auth',
            code: 'not_authenticated',
        });

        expect(send).not.toHaveBeenCalled();
        expect(onNoAck).not.toHaveBeenCalled();
    });

    it('checks auth state before falling back to fire-and-forget send', async () => {
        const authError = new HappyError('Authentication required', false, {
            kind: 'auth',
            code: 'not_authenticated',
        });
        const emitWithAck = vi.fn(async () => {
            throw new Error('timeout');
        });
        const send = vi.fn();
        const onNoAck = vi.fn();
        const beforeFallback = vi.fn(() => {
            throw authError;
        });

        await expect(socketEmitWithAckFallback({
            emitWithAck,
            send,
            event: 'message',
            payload: { sid: 's1', message: 'enc', localId: 'l1' },
            timeoutMs: 7_500,
            onNoAck,
            beforeFallback,
        })).rejects.toMatchObject({
            name: 'HappyError',
            kind: 'auth',
            code: 'not_authenticated',
        });

        expect(beforeFallback).toHaveBeenCalledTimes(1);
        expect(send).not.toHaveBeenCalled();
        expect(onNoAck).not.toHaveBeenCalled();
    });

    it('waits for async fallback checks before fire-and-forget send', async () => {
        let releaseBeforeFallback!: () => void;
        const beforeFallbackSettled = new Promise<void>((resolve) => {
            releaseBeforeFallback = resolve;
        });
        const calls: string[] = [];
        const emitWithAck = vi.fn(async () => {
            throw new Error('timeout');
        });
        const send = vi.fn(() => {
            calls.push('send');
        });
        const onNoAck = vi.fn(() => {
            calls.push('onNoAck');
        });
        const beforeFallback = vi.fn(async () => {
            calls.push('beforeFallback:start');
            await beforeFallbackSettled;
            calls.push('beforeFallback:end');
        });

        const ackPromise = socketEmitWithAckFallback({
            emitWithAck,
            send,
            event: 'message',
            payload: { sid: 's1', message: 'enc', localId: 'l1' },
            timeoutMs: 7_500,
            onNoAck,
            beforeFallback,
        });

        await vi.waitFor(() => {
            expect(beforeFallback).toHaveBeenCalledTimes(1);
        });
        expect(send).not.toHaveBeenCalled();
        expect(onNoAck).not.toHaveBeenCalled();
        expect(calls).toEqual(['beforeFallback:start']);

        releaseBeforeFallback();

        await expect(ackPromise).resolves.toBeNull();
        expect(calls).toEqual(['beforeFallback:start', 'beforeFallback:end', 'send', 'onNoAck']);
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
