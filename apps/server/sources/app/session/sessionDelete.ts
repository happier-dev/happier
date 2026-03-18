import { Context } from "@/context";
import { deleteOwnedSession } from "@/app/session/delete/deleteOwnedSession";

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
    return await deleteOwnedSession({
        sessionId,
        ownerAccountId: ctx.uid,
        reason: 'user_request',
    });
}
