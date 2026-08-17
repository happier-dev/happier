import { Context } from "@/context";
import {
    deleteOwnedSession,
    type DeleteOwnedSessionResult,
} from "@/app/session/delete/deleteOwnedSession";

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
 * @returns a typed deletion or not-found result
 */
export async function sessionDelete(
    ctx: Context,
    sessionId: string,
): Promise<DeleteOwnedSessionResult> {
    return await deleteOwnedSession({
        sessionId,
        ownerAccountId: ctx.uid,
        reason: 'user_request',
    });
}
