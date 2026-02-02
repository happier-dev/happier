import { describe, expect, it, vi } from 'vitest';
import { sessionUpdateHandler } from './sessionUpdateHandler';

class FakeSocket {
    public connected = true;
    public id = 'fake-socket';
    public handlers = new Map<string, any>();

    on(event: string, handler: any) {
        this.handlers.set(event, handler);
    }
}

describe('sessionUpdateHandler', () => {
    it('does not crash on invalid message payloads and acks with invalid-params when callback is provided', async () => {
        const socket = new FakeSocket();

        sessionUpdateHandler(
            'user-1',
            socket as any,
            // minimal connection object for logging
            { connectionType: 'session-scoped', socket: socket as any, userId: 'user-1', sessionId: 's-1' } as any,
        );

        const handler = socket.handlers.get('message');
        expect(typeof handler).toBe('function');

        const callback = vi.fn();
        await handler({ sid: 's-1' }, callback); // missing message

        expect(callback).toHaveBeenCalledWith(
            expect.objectContaining({
                ok: false,
                error: 'invalid-params',
            }),
        );
    });

    it('does not crash on invalid message payloads when callback is missing (old clients)', async () => {
        const socket = new FakeSocket();

        sessionUpdateHandler(
            'user-1',
            socket as any,
            { connectionType: 'session-scoped', socket: socket as any, userId: 'user-1', sessionId: 's-1' } as any,
        );

        const handler = socket.handlers.get('message');
        expect(typeof handler).toBe('function');

        await expect(handler({ sid: 's-1' })).resolves.toBeUndefined();
    });
});
