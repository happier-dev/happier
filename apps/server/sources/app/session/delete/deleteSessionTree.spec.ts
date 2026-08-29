import { describe, expect, it, vi } from 'vitest';

import type { Tx } from '@/storage/inTx';

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

        const deleted = await deleteSessionTree({
            session: {
                updateMany: updateSession,
                deleteMany: vi.fn(async () => ({ count: 1 })),
            },
            sessionMessage: { deleteMany: deleteMessages },
            usageReport: { deleteMany: vi.fn(async () => ({ count: 0 })) },
            accessKey: { deleteMany: vi.fn(async () => ({ count: 0 })) },
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
    });
});
