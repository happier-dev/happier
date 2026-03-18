import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createInTxHarness } from '@/app/api/testkit/txHarness';

const emitUpdate = vi.fn();
const buildDeleteSessionUpdate = vi.fn((_sid: string, updSeq: number, updId: string) => ({
    id: updId,
    seq: updSeq,
    body: { t: 'delete-session', sid: _sid },
}));

vi.mock('@/app/events/eventRouter', () => ({
    eventRouter: { emitUpdate },
    buildDeleteSessionUpdate,
}));

const randomKeyNaked = vi.fn()
    .mockReturnValueOnce('upd-owner')
    .mockReturnValueOnce('upd-u2');
vi.mock('@/utils/keys/randomKeyNaked', () => ({ randomKeyNaked }));

const markAccountChanged = vi.fn(async (_tx: any, params: any) => {
    if (params.accountId === 'owner') return 301;
    if (params.accountId === 'u2') return 302;
    return 999;
});
vi.mock('@/app/changes/markAccountChanged', () => ({ markAccountChanged }));

vi.mock('@/utils/logging/log', () => ({ log: vi.fn() }));

const findFirst = vi.fn();
const deleteSession = vi.fn(async () => ({ count: 1 }));
const deleteMessages = vi.fn(async () => ({ count: 2 }));
const deleteReports = vi.fn(async () => ({ count: 1 }));
const deleteAccessKeys = vi.fn(async () => ({ count: 1 }));

vi.mock('@/storage/inTx', () => {
        const { inTx, afterTx } = createInTxHarness(() => ({
            session: {
                findFirst,
                deleteMany: deleteSession,
            },
            sessionMessage: { deleteMany: deleteMessages },
            usageReport: { deleteMany: deleteReports },
            accessKey: { deleteMany: deleteAccessKeys },
        }));

    return { afterTx, inTx };
});

describe('deleteOwnedSession', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('deletes a session by id for system-initiated retention and emits owner + share updates', async () => {
        const { log } = await import('@/utils/logging/log');
        findFirst.mockResolvedValueOnce({
            id: 's1',
            accountId: 'owner',
            shares: [{ sharedWithUserId: 'u2' }],
        });

        const { deleteOwnedSession } = await import('./deleteOwnedSession');
        const ok = await deleteOwnedSession({ sessionId: 's1', reason: 'retention_policy' });

        expect(ok).toBe(true);
        expect(findFirst).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: 's1' },
        }));
        expect(markAccountChanged).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ accountId: 'owner', kind: 'session', entityId: 's1' }));
        expect(markAccountChanged).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ accountId: 'u2', kind: 'session', entityId: 's1' }));
        expect(deleteMessages).toHaveBeenCalledWith({ where: { sessionId: 's1' } });
        expect(deleteReports).toHaveBeenCalledWith({ where: { sessionId: 's1' } });
        expect(deleteAccessKeys).toHaveBeenCalledWith({ where: { sessionId: 's1' } });
        expect(deleteSession).toHaveBeenCalledWith({ where: { id: 's1' } });
        expect(log).toHaveBeenCalledWith(
            expect.objectContaining({
                module: 'session-delete',
                sessionId: 's1',
                deletedMessages: 2,
                deletedReports: 1,
                deletedAccessKeys: 1,
            }),
            'Session deleted successfully',
        );
        expect(emitUpdate).toHaveBeenCalledTimes(2);
    });

    it('returns false when an explicit ownerAccountId does not match', async () => {
        findFirst.mockResolvedValueOnce(null);

        const { deleteOwnedSession } = await import('./deleteOwnedSession');
        const ok = await deleteOwnedSession({
            sessionId: 's1',
            ownerAccountId: 'owner',
            reason: 'user_request',
        });

        expect(ok).toBe(false);
        expect(deleteSession).not.toHaveBeenCalled();
    });

    it('merges a sessionWhereGuard into the transactional lookup for retention safety', async () => {
        findFirst.mockResolvedValueOnce(null);

        const { deleteOwnedSession } = await import('./deleteOwnedSession');
        const params: Parameters<typeof deleteOwnedSession>[0] & {
            sessionWhereGuard: {
                updatedAt: { lt: Date };
                lastActiveAt: { lt: Date };
            };
        } = {
            sessionId: 's1',
            reason: 'retention_policy',
            sessionWhereGuard: {
                updatedAt: { lt: new Date('2025-01-01T00:00:00.000Z') },
                lastActiveAt: { lt: new Date('2025-01-01T00:00:00.000Z') },
            },
        };

        const ok = await deleteOwnedSession(params);

        expect(ok).toBe(false);
        expect(findFirst).toHaveBeenCalledWith(expect.objectContaining({
            where: {
                id: 's1',
                updatedAt: { lt: new Date('2025-01-01T00:00:00.000Z') },
                lastActiveAt: { lt: new Date('2025-01-01T00:00:00.000Z') },
            },
        }));
    });

    it('returns false when the final guarded delete no longer matches and does not emit updates', async () => {
        const { log } = await import('@/utils/logging/log');
        findFirst.mockResolvedValueOnce({
            id: 's1',
            accountId: 'owner',
            shares: [{ sharedWithUserId: 'u2' }],
        });
        deleteSession.mockResolvedValueOnce({ count: 0 });

        const { deleteOwnedSession } = await import('./deleteOwnedSession');
        const ok = await deleteOwnedSession({
            sessionId: 's1',
            reason: 'retention_policy',
            sessionWhereGuard: {
                updatedAt: { lt: new Date('2025-01-01T00:00:00.000Z') },
                lastActiveAt: { lt: new Date('2025-01-01T00:00:00.000Z') },
            },
        });

        expect(ok).toBe(false);
        expect(deleteSession).toHaveBeenCalledWith({
            where: {
                AND: [
                    { id: 's1' },
                    {
                        updatedAt: { lt: new Date('2025-01-01T00:00:00.000Z') },
                        lastActiveAt: { lt: new Date('2025-01-01T00:00:00.000Z') },
                    },
                ],
            },
        });
        expect(log).not.toHaveBeenCalledWith(
            expect.objectContaining({ module: 'session-delete', sessionId: 's1' }),
            'Session deleted successfully',
        );
        expect(emitUpdate).not.toHaveBeenCalled();
    });
});
