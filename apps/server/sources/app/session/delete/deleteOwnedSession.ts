import { afterTx, inTx } from '@/storage/inTx';
import { log } from '@/utils/logging/log';
import { markAccountChanged } from '@/app/changes/markAccountChanged';

import { deleteSessionTree, SessionDeleteConditionLostError } from './deleteSessionTree';
import { emitSessionDeletedUpdate } from './emitSessionDeletedUpdate';
import { loadSessionDeleteRecipients } from './loadSessionDeleteRecipients';

/**
 * Deletion outcomes are kept apart because callers act on them differently.
 *
 * - `not-found`: the session is absent, or not owned by / not reachable for the
 *   caller under the supplied guard. The row this caller could delete does not
 *   exist, so a client may safely retire its own copy of it.
 * - `conflict`: the session WAS found, but the guarded delete lost its condition
 *   between the read and the write (a concurrent metadata write, or a retention
 *   guard that stopped matching). Nothing was deleted and the row still exists,
 *   so this is retryable and must never be read as "already gone".
 */
export type DeleteOwnedSessionResult =
    | Readonly<{ ok: true }>
    | Readonly<{
        ok: false;
        error: 'not-found' | 'conflict';
    }>;

type DeleteOwnedSessionCommonParams = Readonly<{
    sessionId: string;
    sessionWhereGuard?: Record<string, unknown>;
}>;

export type DeleteOwnedSessionParams =
    | (DeleteOwnedSessionCommonParams & Readonly<{
        reason: 'user_request';
        ownerAccountId: string;
    }>)
    | (DeleteOwnedSessionCommonParams & Readonly<{
        reason: 'retention_policy';
        ownerAccountId?: string | null;
    }>);

export async function deleteOwnedSession(
    params: DeleteOwnedSessionParams,
): Promise<DeleteOwnedSessionResult> {
    try {
        return await inTx(async (tx) => {
            const session = await loadSessionDeleteRecipients(tx as any, {
                sessionId: params.sessionId,
                ownerAccountId: params.ownerAccountId ?? null,
                sessionWhereGuard: params.sessionWhereGuard,
            });

            if (!session) {
                log(
                    { module: 'session-delete', userId: params.ownerAccountId ?? null, sessionId: params.sessionId, reason: params.reason },
                    'Session not found or not owned by user',
                );
                return { ok: false, error: 'not-found' } as const;
            }

            const isCallerInitiated = params.reason === 'user_request';
            const recipientAccountIds = new Set<string>();
            recipientAccountIds.add(session.accountId);
            for (const share of session.shares) {
                recipientAccountIds.add(share.sharedWithUserId);
            }

            const sessionDeleteWhere = {
                ...(params.ownerAccountId ? { accountId: params.ownerAccountId } : null),
                ...(params.sessionWhereGuard ?? null),
                ...(isCallerInitiated
                    ? {
                        metadataLayoutVersion:
                            session.metadataLayoutVersion,
                    }
                    : null),
            };
            const recipientCursors: Array<{ accountId: string; cursor: number }> = [];
            const deleted = await deleteSessionTree(tx as any, {
                sessionId: params.sessionId,
                sessionUpdatedAt: session.updatedAt,
                actorAccountId: session.accountId,
                reason: params.reason,
                sessionDeleteWhere: Object.keys(sessionDeleteWhere).length > 0 ? sessionDeleteWhere : undefined,
                afterSessionWriteBoundary: async () => {
                    for (const accountId of recipientAccountIds) {
                        const cursor = await markAccountChanged(tx as any, {
                            accountId,
                            kind: 'session',
                            entityId: params.sessionId,
                        });
                        recipientCursors.push({ accountId, cursor });
                    }
                },
            });

            afterTx(tx as any, async () => {
                log(
                    {
                        module: 'session-delete',
                        userId: session.accountId,
                        sessionId: params.sessionId,
                        reason: params.reason,
                        deletedMessages: deleted.deletedMessages,
                        deletedReports: deleted.deletedReports,
                        deletedAccessKeys: deleted.deletedAccessKeys,
                    },
                    'Session deleted successfully',
                );
                await Promise.all(recipientCursors.map(async ({ accountId, cursor }) => {
                    await emitSessionDeletedUpdate({
                        sessionId: params.sessionId,
                        accountId,
                        cursor,
                    });
                }));
            });

            return { ok: true } as const;
        });
    } catch (error) {
        if (error instanceof SessionDeleteConditionLostError) {
            return { ok: false, error: 'conflict' };
        }
        throw error;
    }
}
