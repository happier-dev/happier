import { Context } from "@/context";
import { inTx, afterTx } from "@/storage/inTx";
import { eventRouter, buildDeleteSessionUpdate } from "@/app/events/eventRouter";
import { randomKeyNaked } from "@/utils/randomKeyNaked";
import { log } from "@/utils/log";
import { markAccountChanged } from "@/app/changes/markAccountChanged";

/**
 * Delete a session and all its related data.
 * Handles:
 * - Deleting all session messages
 * - Deleting all usage reports for the session
 * - Deleting all access keys for the session
 * - Deleting the session itself
 * - Sending socket notification to all connected clients
 * 
 * @param ctx - Context with user information
 * @param sessionId - ID of the session to delete
 * @returns true if deletion was successful, false if session not found or not owned by user
 */
export async function sessionDelete(ctx: Context, sessionId: string): Promise<boolean> {
    return await inTx(async (tx) => {
        // Verify session exists and belongs to the user
        const session = await tx.session.findFirst({
            where: {
                id: sessionId,
                accountId: ctx.uid
            },
            select: {
                id: true,
                shares: {
                    select: {
                        sharedWithUserId: true,
                    },
                },
            },
        });

        if (!session) {
            log({ 
                module: 'session-delete', 
                userId: ctx.uid, 
                sessionId 
            }, `Session not found or not owned by user`);
            return false;
        }

        // Delete all related data
        // Note: Order matters to avoid foreign key constraint violations
        
        // 1. Delete session messages
        const deletedMessages = await tx.sessionMessage.deleteMany({
            where: { sessionId }
        });
        log({ 
            module: 'session-delete', 
            userId: ctx.uid, 
            sessionId,
            deletedCount: deletedMessages.count
        }, `Deleted ${deletedMessages.count} session messages`);

        // 2. Delete usage reports
        const deletedReports = await tx.usageReport.deleteMany({
            where: { sessionId }
        });
        log({ 
            module: 'session-delete', 
            userId: ctx.uid, 
            sessionId,
            deletedCount: deletedReports.count
        }, `Deleted ${deletedReports.count} usage reports`);

        // 3. Delete access keys
        const deletedAccessKeys = await tx.accessKey.deleteMany({
            where: { sessionId }
        });
        log({ 
            module: 'session-delete', 
            userId: ctx.uid, 
            sessionId,
            deletedCount: deletedAccessKeys.count
        }, `Deleted ${deletedAccessKeys.count} access keys`);

        // 4. Delete the session itself
        await tx.session.delete({
            where: { id: sessionId }
        });
        log({ 
            module: 'session-delete', 
            userId: ctx.uid, 
            sessionId 
        }, `Session deleted successfully`);

        const recipientAccountIds = new Set<string>();
        recipientAccountIds.add(ctx.uid);
        for (const share of session.shares) {
            recipientAccountIds.add(share.sharedWithUserId);
        }

        const recipientCursors: Array<{ accountId: string; cursor: number }> = [];
        for (const accountId of recipientAccountIds) {
            const cursor = await markAccountChanged(tx, { accountId, kind: 'session', entityId: sessionId });
            recipientCursors.push({ accountId, cursor });
        }

        // Send notification after transaction commits
        afterTx(tx, async () => {
            await Promise.all(recipientCursors.map(async ({ accountId, cursor }) => {
                const updatePayload = buildDeleteSessionUpdate(sessionId, cursor, randomKeyNaked(12));

                log({
                    module: 'session-delete',
                    userId: accountId,
                    sessionId,
                    updateType: 'delete-session',
                    updateId: updatePayload.id,
                    updateSeq: updatePayload.seq,
                }, 'Emitting delete-session update to user-scoped connections');

                eventRouter.emitUpdate({
                    userId: accountId,
                    payload: updatePayload,
                    recipientFilter: { type: 'user-scoped-only' },
                });
            }));
        });

        return true;
    });
}
