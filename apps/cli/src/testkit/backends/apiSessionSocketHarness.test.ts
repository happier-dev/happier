import { describe, expect, it, vi } from 'vitest';

import {
    bindApiSessionSocketMock,
    bindApiSessionSocketPairMock,
    bindApiSessionSocketSequenceMock,
    createApiSessionSocketStub,
} from './apiSessionSocketHarness';

describe('apiSessionSocketHarness', () => {
    it('triggers connect listeners and runs onConnect hooks', () => {
        const onConnect = vi.fn();
        const socket = createApiSessionSocketStub({ onConnect });
        const handler = vi.fn();

        socket.on('connect', handler);
        socket.connect();

        expect(socket.connected).toBe(true);
        expect(onConnect).toHaveBeenCalledWith(socket);
        expect(handler).toHaveBeenCalledTimes(1);
    });

    it('routes custom emit behavior through the socket stub', () => {
        const emit = vi.fn((_event: string, args: unknown[]) => {
            const [, callback] = args;
            if (typeof callback === 'function') {
                callback({ ok: true });
            }
            return 'custom-result';
        });
        const socket = createApiSessionSocketStub({ emit });
        const callback = vi.fn();

        const result = socket.emit('message', { id: 'm1' }, callback);

        expect(result).toBe('custom-result');
        expect(emit).toHaveBeenCalledWith('message', [{ id: 'm1' }, callback], socket);
        expect(callback).toHaveBeenCalledWith({ ok: true });
    });

    it('can emit a disconnect event when the stub disconnects', () => {
        const socket = createApiSessionSocketStub({ disconnectReason: 'io client disconnect' });
        const handler = vi.fn();

        socket.on('disconnect', handler);
        socket.disconnect();

        expect(socket.connected).toBe(false);
        expect(handler).toHaveBeenCalledWith('io client disconnect');
    });

    it('can emit a disconnect event when the stub closes', () => {
        const socket = createApiSessionSocketStub({ disconnectReason: 'transport closed' });
        const handler = vi.fn();

        socket.on('disconnect', handler);
        socket.close();

        expect(socket.connected).toBe(false);
        expect(handler).toHaveBeenCalledWith('transport closed');
    });

    it('binds a single socket for every mockIo call when requested', () => {
        const mockIo = vi.fn();
        const socket = createApiSessionSocketStub({ id: 'single-socket' });

        bindApiSessionSocketMock(mockIo, socket);

        expect(mockIo()).toBe(socket);
        expect(mockIo()).toBe(socket);
    });

    it('keeps pair-binding behavior for user/session ordering', () => {
        const mockIo = vi.fn();
        const userSocket = createApiSessionSocketStub({ id: 'user-socket' });
        const sessionSocket = createApiSessionSocketStub({ id: 'session-socket' });
        const fallbackSocket = createApiSessionSocketStub({ id: 'fallback-socket' });

        bindApiSessionSocketPairMock(mockIo, { userSocket, sessionSocket, fallbackSocket });

        expect(mockIo()).toBe(userSocket);
        expect(mockIo()).toBe(sessionSocket);
        expect(mockIo()).toBe(fallbackSocket);
    });

    it('binds a staged socket sequence and reuses the final fallback socket', () => {
        const mockIo = vi.fn();
        const firstSocket = createApiSessionSocketStub({ id: 'first-socket' });
        const secondSocket = createApiSessionSocketStub({ id: 'second-socket' });

        bindApiSessionSocketSequenceMock(mockIo, [firstSocket, secondSocket]);

        expect(mockIo()).toBe(firstSocket);
        expect(mockIo()).toBe(secondSocket);
        expect(mockIo()).toBe(secondSocket);
    });
});
