import { afterTx, inTx } from '@/storage/inTx';
import { log } from '@/utils/logging/log';
import { markAccountChanged } from '@/app/changes/markAccountChanged';

import { deleteSessionTree, SessionDeleteConditionLostError } from './deleteSessionTree';
import { emitSessionDeletedUpdate } from './emitSessionDeletedUpdate';
import { loadSessionDeleteRecipients } from './loadSessionDeleteRecipients';

export async function deleteOwnedSession(params: {
    sessionId: string;
    ownerAccountId?: string | null;
    reason: 'user_request' | 'retention_policy';
    sessionWhereGuard?: Record<string, unknown>;
}): Promise<boolean> {
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
                return false;
            }

            const recipientAccountIds = new Set<string>();
            recipientAccountIds.add(session.accountId);
            for (const share of session.shares) {
                recipientAccountIds.add(share.sharedWithUserId);
            }

            const recipientCursors: Array<{ accountId: string; cursor: number }> = [];
            for (const accountId of recipientAccountIds) {
                const cursor = await markAccountChanged(tx as any, {
                    accountId,
                    kind: 'session',
                    entityId: params.sessionId,
                });
                recipientCursors.push({ accountId, cursor });
            }

            await deleteSessionTree(tx as any, {
                sessionId: params.sessionId,
                actorAccountId: session.accountId,
                reason: params.reason,
                sessionDeleteWhere: {
                    ...(params.ownerAccountId ? { accountId: params.ownerAccountId } : null),
                    ...(params.sessionWhereGuard ?? null),
                },
            });

            afterTx(tx as any, async () => {
                await Promise.all(recipientCursors.map(async ({ accountId, cursor }) => {
                    await emitSessionDeletedUpdate({
                        sessionId: params.sessionId,
                        accountId,
                        cursor,
                    });
                }));
            });

            return true;
        });
    } catch (error) {
        if (error instanceof SessionDeleteConditionLostError) {
            return false;
        }
        throw error;
    }
}
