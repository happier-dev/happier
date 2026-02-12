import { describe, expect, it, vi } from 'vitest';

import { withSessionProjectScmOperationLock } from './withOperationLock';

describe('withSessionProjectScmOperationLock', () => {
    it('returns blocked result when a project lock is already held', async () => {
        const run = vi.fn(async () => 'ok');
        const result = await withSessionProjectScmOperationLock({
            state: {
                beginSessionProjectScmOperation: () => ({
                    started: false as const,
                    reason: 'operation_in_flight' as const,
                    inFlight: {
                        id: '123',
                        startedAt: 10,
                        sessionId: 'other',
                        operation: 'push' as const,
                    },
                }),
                finishSessionProjectScmOperation: () => false,
            },
            sessionId: 's1',
            operation: 'commit',
            run,
        });

        expect(result.started).toBe(false);
        if (!result.started) {
            expect(result.message).toContain('running');
            expect(result.message).toContain('push');
        }
        expect(run).not.toHaveBeenCalled();
    });

    it('finishes the lock after a successful operation', async () => {
        const finish = vi.fn(() => true);
        const result = await withSessionProjectScmOperationLock({
            state: {
                beginSessionProjectScmOperation: () => ({
                    started: true as const,
                    operation: {
                        id: 'op-1',
                        startedAt: 10,
                        sessionId: 's1',
                        operation: 'commit' as const,
                    },
                }),
                finishSessionProjectScmOperation: finish,
            },
            sessionId: 's1',
            operation: 'commit',
            run: async () => 'done',
        });

        expect(result).toEqual({ started: true, value: 'done' });
        expect(finish).toHaveBeenCalledWith('s1', 'op-1');
    });

    it('finishes the lock even when run throws', async () => {
        const finish = vi.fn(() => true);
        await expect(
            withSessionProjectScmOperationLock({
                state: {
                    beginSessionProjectScmOperation: () => ({
                        started: true as const,
                        operation: {
                            id: 'op-2',
                            startedAt: 11,
                            sessionId: 's1',
                            operation: 'pull' as const,
                        },
                    }),
                    finishSessionProjectScmOperation: finish,
                },
                sessionId: 's1',
                operation: 'pull',
                run: async () => {
                    throw new Error('boom');
                },
            })
        ).rejects.toThrow('boom');

        expect(finish).toHaveBeenCalledWith('s1', 'op-2');
    });
});
