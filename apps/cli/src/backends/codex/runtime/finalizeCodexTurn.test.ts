import { describe, expect, it, vi } from 'vitest';

import { HttpStatusError } from '@/api/client/httpStatusError';
import { finalizeCodexTurn } from './finalizeCodexTurn';

describe('finalizeCodexTurn', () => {
    it('flushes the remote runtime, resets turn state, and emits ready when the queue drains', async () => {
        const flushTurn = vi.fn(async () => {});
        const syncFromMetadata = vi.fn();
        const permissionHandler = { reset: vi.fn() };
        const diffProcessor = {
            flushTurn: vi.fn(),
            reset: vi.fn(),
        };
        const keepAlive = vi.fn();
        const popPendingMessage = vi.fn(async () => false);
        const sendReady = vi.fn();
        const logActiveHandles = vi.fn();
        const emitReadyIfIdleFn = vi.fn(() => true);
        const setThinking = vi.fn();

        await finalizeCodexTurn({
            runtime: { flushTurn },
            runtimeControlSync: { syncFromMetadata },
            permissionHandler,
            diffProcessor,
            session: {
                keepAlive,
                popPendingMessage,
            },
            pending: null,
            shouldExit: false,
            queueSize: () => 0,
            sendReady,
            logActiveHandles,
            setThinking,
            emitReadyIfIdleFn,
        });

        expect(flushTurn).toHaveBeenCalledTimes(1);
        expect(syncFromMetadata).toHaveBeenCalledTimes(1);
        expect(permissionHandler.reset).toHaveBeenCalledTimes(1);
        expect(diffProcessor.flushTurn).toHaveBeenCalledTimes(1);
        expect(diffProcessor.reset).toHaveBeenCalledTimes(1);
        expect(setThinking).toHaveBeenCalledWith(false);
        expect(keepAlive).toHaveBeenCalledWith(false, 'remote');
        expect(popPendingMessage).toHaveBeenCalledTimes(1);
        expect(emitReadyIfIdleFn).toHaveBeenCalledWith({
            pending: null,
            queueSize: expect.any(Function),
            shouldExit: false,
            sendReady,
        });
        expect(logActiveHandles).toHaveBeenCalledWith('after-turn');
    });

    it('rethrows terminal auth failures from pending drainage instead of emitting ready', async () => {
        const emitReadyIfIdleFn = vi.fn(() => true);

        await expect(
            finalizeCodexTurn({
                runtime: { flushTurn: vi.fn(async () => {}) },
                runtimeControlSync: { syncFromMetadata: vi.fn() },
                permissionHandler: { reset: vi.fn() },
                diffProcessor: {
                    flushTurn: vi.fn(),
                    reset: vi.fn(),
                },
                session: {
                    keepAlive: vi.fn(),
                    popPendingMessage: vi.fn(async () => {
                        throw new HttpStatusError(401, 'Authentication failed');
                    }),
                },
                pending: null,
                shouldExit: false,
                queueSize: () => 0,
                sendReady: vi.fn(),
                logActiveHandles: vi.fn(),
                setThinking: vi.fn(),
                emitReadyIfIdleFn,
            }),
        ).rejects.toMatchObject({
            name: 'HttpStatusError',
            response: { status: 401 },
        });

        expect(emitReadyIfIdleFn).not.toHaveBeenCalled();
    });
});
