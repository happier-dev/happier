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
    it('keeps the socket as the receiver when a timeout scope is applied', async () => {
        // `F-UI-2`: socket.io's `emitWithAck` is a prototype method whose body is `this.emit(...)`,
        // and its `timeout(ms)` returns the socket itself. Reading `.emitWithAck` off that result and
        // calling the bare reference detaches `this`, so the library throws
        // `Cannot read properties of undefined (reading 'emit')` — the raw TypeError observed on the
        // folder picker and the git surface. The previous double here was a fresh object literal
        // holding a standalone `vi.fn`, which has no `this` dependency and could never see it.
        const emitted: Array<{ event: string; payload: unknown }> = [];
        const socketIoShapedSocket = {
            flags: {} as { timeout?: number },
            emit(event: string, payload: unknown): void {
                emitted.push({ event, payload });
            },
            timeout(ms: number) {
                this.flags.timeout = ms;
                return this;
            },
            emitWithAck(event: string, payload: unknown): Promise<unknown> {
                return new Promise((resolve) => {
                    this.emit(event, payload);
                    resolve({ ok: true });
                });
            },
        };

        await expect(scopedSocketEmitWithAck({
            socket: socketIoShapedSocket,
            event: SOCKET_RPC_EVENTS.CALL,
            payload: { method: 'daemon.filesystem.listRoots', params: {}, requestId: 'r-1' },
            timeoutMs: 1_000,
            requestId: 'r-1',
        })).resolves.toEqual({ ok: true });

        expect(socketIoShapedSocket.flags.timeout).toBe(1_000);
        expect(emitted).toEqual([{
            event: SOCKET_RPC_EVENTS.CALL,
            payload: { method: 'daemon.filesystem.listRoots', params: {}, requestId: 'r-1' },
        }]);
    });
});
