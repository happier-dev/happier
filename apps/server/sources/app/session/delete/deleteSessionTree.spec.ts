import { describe, expect, it, vi } from 'vitest';

const transactionHarness = vi.hoisted(() => ({ afterCommit: [] as Array<() => void> }));
vi.mock('@/storage/inTx', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/storage/inTx')>(),
    afterTx: (_tx: unknown, callback: () => void) => transactionHarness.afterCommit.push(callback),
}));

import type { Tx } from '@/storage/inTx';
import {
    createAccountCursorRawQueryTransactionModel,
    createEmptySessionFollowEdgeTransactionModel,
} from '@/app/api/testkit/txHarness';

import { deleteSessionTree } from './deleteSessionTree';

describe('deleteSessionTree', () => {
    it('crosses the session write boundary before deleting committed transcript rows', async () => {
        let admittedTranscriptWriteCommitted = false;

        const updateSession = vi.fn(async () => {
            admittedTranscriptWriteCommitted = true;
            return { count: 1 };
        });
        const deleteMessages = vi.fn(async () => ({
            count: admittedTranscriptWriteCommitted ? 1 : 0,
        }));
        const session = {
            id: 'voice-history-session', accountId: 'account-1', seq: 0,
            account: { status: 'active' }, currentStorageState: 'hosted',
            acceptedThroughServerSeq: null, materializationPublicationId: null,
            materializedThroughSourceAt: null, publishedThroughServerSeq: null,
            grants: [], 
        };
        const account = {
            findMany: vi.fn(async () => [{ id: 'account-1' }]),
            update: vi.fn(async () => ({ seq: 1 })),
        };
        const accountChange = { upsert: vi.fn(async () => ({})) };
        const queryRawUnsafe = vi.fn(createAccountCursorRawQueryTransactionModel({ account, accountChange }));

        const deleted = await deleteSessionTree({
            session: {
                findUnique: vi.fn(async () => session),
                findMany: vi.fn(async () => [session]),
                updateMany: updateSession,
                deleteMany: vi.fn(async () => ({ count: 1 })),
            },
            account,
            accountChange,
            $queryRawUnsafe: queryRawUnsafe,
            sessionGrant: { findMany: vi.fn(async () => []) },
            
            
            sessionMessage: { deleteMany: deleteMessages },
            usageReport: { deleteMany: vi.fn(async () => ({ count: 0 })) },
            accessKey: { deleteMany: vi.fn(async () => ({ count: 0 })) },
            ephemeralRunnerActivation: { findFirst: vi.fn(async () => null) },
            sessionFollowEdge: createEmptySessionFollowEdgeTransactionModel(),
        } as unknown as Tx, {
            sessionId: 'voice-history-session',
            sessionUpdatedAt: new Date('2026-07-01T00:00:00.000Z'),
            actorAccountId: 'account-1',
            reason: 'user_request',
            sessionDeleteWhere: {
                accountId: 'account-1',
                metadataLayoutVersion: 1,
            },
        });

        expect(deleted.deletedMessages).toBe(1);
        expect(queryRawUnsafe.mock.invocationCallOrder[0]!).toBeLessThan(
            updateSession.mock.invocationCallOrder[0]!,
        );
        expect(updateSession).toHaveBeenCalledWith({
            where: {
                AND: [
                    { id: 'voice-history-session' },
                    {
                        accountId: 'account-1',
                        metadataLayoutVersion: 1,
                    },
                ],
            },
            data: {
                seq: { increment: 1 },
                updatedAt: new Date('2026-07-01T00:00:00.000Z'),
            },
        });
        expect(updateSession.mock.invocationCallOrder[0]!).toBeLessThan(
            deleteMessages.mock.invocationCallOrder[0]!,
        );
        expect(transactionHarness.afterCommit).toHaveLength(1);
    });
});
