import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    createEmptySessionFollowEdgeTransactionModel,
    createInTxHarness,
} from '@/app/api/testkit/txHarness';

let deleteOwnedSession: typeof import('./deleteOwnedSession').deleteOwnedSession;

const emitUpdate = vi.fn();
// Socket emission is the transport boundary; deletion and change projection stay real.
vi.mock('@/app/events/eventRouter', async () => {
    const actual = await vi.importActual<typeof import('@/app/events/eventRouter')>('@/app/events/eventRouter');
    return { ...actual, eventRouter: { ...actual.eventRouter, emitUpdate } };
});

const randomKeyNaked = vi.fn()
    .mockReturnValueOnce('upd-owner')
    .mockReturnValueOnce('upd-u2');
vi.mock('@/utils/keys/randomKeyNaked', () => ({ randomKeyNaked }));

const upsertAccountChange = vi.fn(async () => ({}));
const allocateAccountSeq = vi.fn(async (params: { where: { id: string } }) => ({
    seq: params.where.id === 'owner' ? 301 : 302,
}));
const findAudienceAccounts = vi.fn();
const findSession = vi.fn(async () => ({
    accountId: 'owner',
    account: { status: 'active' },
    seq: 0,
    currentStorageState: 'hosted',
    acceptedThroughServerSeq: null,
    materializationPublicationId: null,
    materializedThroughSourceAt: null,
    publishedThroughServerSeq: null,
    teamGrants: [],
    groupGrants: [],
}));

vi.mock('@/utils/logging/log', () => ({ log: vi.fn() }));

const findFirst = vi.fn();
const claimSession = vi.fn(async () => ({ count: 1 }));
const deleteSession = vi.fn(async () => ({ count: 1 }));
const deleteMessages = vi.fn(async () => ({ count: 2 }));
const deleteReports = vi.fn(async () => ({ count: 1 }));
const deleteAccessKeys = vi.fn(async () => ({ count: 1 }));
const findRunnerActivation = vi.fn(async () => null);
const findSessionDraft = vi.fn(async () => null);
const findSessionDrafts = vi.fn(async () => []);

vi.mock('@/storage/inTx', () => {
        const { inTx, afterTx } = createInTxHarness(() => ({
            session: {
                findFirst,
                findUnique: findSession,
                updateMany: claimSession,
                deleteMany: deleteSession,
            },
            account: { findMany: findAudienceAccounts, update: allocateAccountSeq },
            accountChange: { upsert: upsertAccountChange },
            sessionMessage: { deleteMany: deleteMessages },
            usageReport: { deleteMany: deleteReports },
            accessKey: { deleteMany: deleteAccessKeys },
            ephemeralRunnerActivation: { findFirst: findRunnerActivation },
            sessionFollowEdge: createEmptySessionFollowEdgeTransactionModel(),
            sessionReportsTo: { findMany: vi.fn(async () => []) },
            automation: { findMany: vi.fn(async () => []) },
            userKVStore: { findMany: findSessionDrafts, findUnique: findSessionDraft },
        }));

    return { afterTx, inTx };
});

function seedDeleteTarget(metadataLayoutVersion: 0 | 1, recipientAccountIds: string[]): void {
    findFirst.mockResolvedValueOnce({
        id: 's1',
        accountId: 'owner',
        metadataLayoutVersion,
        updatedAt: new Date('2025-01-01T00:00:00.000Z'),
    });
    findAudienceAccounts.mockResolvedValueOnce(recipientAccountIds.map(id => ({ id })));
}

describe('deleteOwnedSession', () => {
    beforeAll(async () => {
        ({ deleteOwnedSession } = await import('./deleteOwnedSession'));
    });

    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('deletes a session by id for system-initiated retention and emits owner + share updates', async () => {
        const { log } = await import('@/utils/logging/log');
        seedDeleteTarget(0, ['owner', 'u2']);

        const ok = await deleteOwnedSession({ sessionId: 's1', reason: 'retention_policy' });

        expect(ok).toEqual({ ok: true });
        expect(findFirst).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: 's1' },
        }));
        expect(upsertAccountChange).toHaveBeenCalledWith(expect.objectContaining({
            create: expect.objectContaining({
            accountId: 'owner',
            kind: 'session',
            entityId: 's1',
            hint: { lifecycle: 'deleted', v: 1 },
            }),
        }));
        expect(upsertAccountChange).toHaveBeenCalledWith(expect.objectContaining({
            create: expect.objectContaining({
            accountId: 'u2',
            kind: 'session',
            entityId: 's1',
            hint: { lifecycle: 'deleted', v: 1 },
            }),
        }));
        expect(claimSession.mock.invocationCallOrder[0]!).toBeLessThan(
            upsertAccountChange.mock.invocationCallOrder[0]!,
        );
        expect(upsertAccountChange.mock.invocationCallOrder[0]!).toBeLessThan(
            deleteMessages.mock.invocationCallOrder[0]!,
        );
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
        const deletionUpdates = emitUpdate.mock.calls.filter(([update]) => update.payload.body.t === 'delete-session');
        expect(deletionUpdates).toHaveLength(2);
        expect(deletionUpdates).toEqual(expect.arrayContaining([
            [expect.objectContaining({
                userId: 'owner',
                recipientFilter: { type: 'user-scoped-only' },
            })],
            [expect.objectContaining({
                userId: 'u2',
                recipientFilter: { type: 'user-scoped-only' },
            })],
        ]));
    });

    it('contains an after-commit deletion publication failure without an unhandled rejection', async () => {
        const publicationFailure = new Error('recipient transport unavailable');
        emitUpdate.mockImplementationOnce(() => {
            throw publicationFailure;
        });
        seedDeleteTarget(0, ['owner']);

        const result = await deleteOwnedSession({ sessionId: 's1', reason: 'retention_policy' });

        expect(result).toEqual({ ok: true });
        await vi.waitFor(async () => {
            const { log } = await import('@/utils/logging/log');
            expect(log).toHaveBeenCalledWith(
                expect.objectContaining({
                    module: 'session-delete',
                    sessionId: 's1',
                    error: publicationFailure,
                }),
                'Failed to emit one or more delete-session updates',
            );
        });
    });

    it('returns false when an explicit ownerAccountId does not match', async () => {
        findFirst.mockResolvedValueOnce(null);

        const ok = await deleteOwnedSession({
            sessionId: 's1',
            ownerAccountId: 'owner',
            reason: 'user_request',
        });

        expect(ok).toEqual({ ok: false, error: 'not-found' });
        expect(deleteSession).not.toHaveBeenCalled();
    });

    it('merges a sessionWhereGuard into the transactional lookup for retention safety', async () => {
        findFirst.mockResolvedValueOnce(null);

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

        expect(ok).toEqual({ ok: false, error: 'not-found' });
        expect(findFirst).toHaveBeenCalledWith(expect.objectContaining({
            where: {
                id: 's1',
                updatedAt: { lt: new Date('2025-01-01T00:00:00.000Z') },
                lastActiveAt: { lt: new Date('2025-01-01T00:00:00.000Z') },
            },
        }));
    });

    it('does not let an additional guard replace the exact session or Account owner', async () => {
        findFirst.mockResolvedValueOnce(null);

        const result = await deleteOwnedSession({
            sessionId: 's1',
            ownerAccountId: 'owner',
            reason: 'user_request',
            sessionWhereGuard: {
                id: 'different-session',
                accountId: 'different-owner',
                updatedAt: { lt: new Date('2025-01-01T00:00:00.000Z') },
            },
        });

        expect(result).toEqual({ ok: false, error: 'not-found' });
        expect(findFirst).toHaveBeenCalledWith(expect.objectContaining({
            where: {
                id: 's1',
                accountId: 'owner',
                updatedAt: { lt: new Date('2025-01-01T00:00:00.000Z') },
            },
        }));
    });

    it('reports a lost delete condition as a conflict, not as an absent session, and emits nothing', async () => {
        const { log } = await import('@/utils/logging/log');
        seedDeleteTarget(0, ['owner', 'u2']);
        deleteSession.mockResolvedValueOnce({ count: 0 });

        const ok = await deleteOwnedSession({
            sessionId: 's1',
            reason: 'retention_policy',
            sessionWhereGuard: {
                updatedAt: { lt: new Date('2025-01-01T00:00:00.000Z') },
                lastActiveAt: { lt: new Date('2025-01-01T00:00:00.000Z') },
            },
        });

        expect(ok).toEqual({ ok: false, error: 'conflict' });
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

    it('separates a session that is absent or not owned from one whose delete condition was lost', async () => {
        findFirst.mockResolvedValueOnce(null);
        const absent = await deleteOwnedSession({
            sessionId: 's1',
            ownerAccountId: 'owner',
            reason: 'user_request',
        });

        seedDeleteTarget(1, ['owner']);
        claimSession.mockResolvedValueOnce({ count: 0 });
        const conflicted = await deleteOwnedSession({
            sessionId: 's1',
            ownerAccountId: 'owner',
            reason: 'user_request',
        });

        expect(absent).toEqual({ ok: false, error: 'not-found' });
        expect(conflicted).toEqual({ ok: false, error: 'conflict' });
        expect(deleteSession).not.toHaveBeenCalled();
        expect(emitUpdate).not.toHaveBeenCalled();
    });

    it('allows deletion of a layout-1 session without interpreting its stored content', async () => {
        seedDeleteTarget(1, ['owner', 'u2']);

        const result = await deleteOwnedSession({
            sessionId: 's1',
            ownerAccountId: 'owner',
            reason: 'user_request',
        });

        expect(result).toEqual({ ok: true });
        expect(upsertAccountChange).toHaveBeenCalledTimes(2);
        expect(deleteMessages).toHaveBeenCalledOnce();
        expect(deleteSession).toHaveBeenCalledOnce();
    });

    it('keeps legacy layout-0 deletion valid and carries the layout fence into the final delete', async () => {
        seedDeleteTarget(0, ['owner']);

        const result = await deleteOwnedSession({
            sessionId: 's1',
            ownerAccountId: 'owner',
            reason: 'user_request',
        });

        expect(result).toEqual({ ok: true });
        expect(deleteSession).toHaveBeenCalledWith({
            where: {
                AND: [
                    { id: 's1' },
                    {
                        accountId: 'owner',
                        metadataLayoutVersion: 0,
                    },
                ],
            },
        });
    });

    it('deletes layout 1 with the observed layout guarded atomically', async () => {
        seedDeleteTarget(1, ['owner']);

        const result = await deleteOwnedSession({
            sessionId: 's1',
            ownerAccountId: 'owner',
            reason: 'user_request',
        });

        expect(result).toEqual({ ok: true });
        expect(deleteSession).toHaveBeenCalledWith({
            where: {
                AND: [
                    { id: 's1' },
                    {
                        accountId: 'owner',
                        metadataLayoutVersion: 1,
                    },
                ],
            },
        });
    });
});
