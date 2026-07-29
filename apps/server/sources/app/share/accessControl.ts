import { db } from "@/storage/db";
import type { Tx } from "@/storage/inTx";
import { ShareAccessLevel } from "@/storage/prisma";
import {
    isSessionTranscriptShareable,
    SESSION_TRANSCRIPT_PUBLICATION_SELECT,
} from "@/app/session/sessionTranscriptPublicationPolicy";

type SessionAccessClient = Pick<Tx, "session" | "sessionShare">;

/**
 * Access level for session sharing (including owner)
 */
export type AccessLevel = ShareAccessLevel | 'owner';

/**
 * Session access information for a user
 */
export interface SessionAccess {
    /** User ID requesting access */
    userId: string;
    /** Session ID being accessed */
    sessionId: string;
    /** Access level granted to user */
    level: AccessLevel;
    /** Whether user is session owner */
    isOwner: boolean;
    /** Cached session activity state, when available from the access lookup */
    sessionActive?: boolean;
    /** Cached session last-active timestamp, when available from the access lookup */
    sessionLastActiveAt?: Date | null;
}

/**
 * Check user's access level for a session
 *
 * @param userId - User ID requesting access
 * @param sessionId - Session ID to check
 * @returns Session access info, or null if no access
 */
export async function checkSessionAccess(
    userId: string,
    sessionId: string,
    client: SessionAccessClient = db,
): Promise<SessionAccess | null> {
    // First check if user owns the session
    const session = await client.session.findUnique({
        where: { id: sessionId },
        select: {
            accountId: true,
            active: true,
            lastActiveAt: true,
            ...SESSION_TRANSCRIPT_PUBLICATION_SELECT,
        }
    });

    if (!session) {
        return null;
    }

    if (session.accountId === userId) {
        return {
            userId,
            sessionId,
            level: 'owner',
            isOwner: true,
            sessionActive: session.active,
            sessionLastActiveAt: session.lastActiveAt,
        };
    }

    if (!isSessionTranscriptShareable(session)) {
        return null;
    }

    // Check if session is shared with user
    const share = await client.sessionShare.findUnique({
        where: {
            sessionId_sharedWithUserId: {
                sessionId,
                sharedWithUserId: userId
            }
        },
        select: { accessLevel: true }
    });

    if (share) {
        return {
            userId,
            sessionId,
            level: share.accessLevel,
            isOwner: false,
            sessionActive: session.active,
            sessionLastActiveAt: session.lastActiveAt,
        };
    }

    return null;
}

/**
 * Check if user has required access level
 *
 * @param access - User's session access
 * @param required - Required access level
 * @returns True if user has sufficient access
 */
export function requireAccessLevel(
    access: SessionAccess,
    required: AccessLevel
): boolean {
    const levels: AccessLevel[] = ['view', 'edit', 'admin', 'owner'];
    const userLevel = levels.indexOf(access.level);
    const requiredLevel = levels.indexOf(required);
    return userLevel >= requiredLevel;
}

/**
 * Check if user can view session
 *
 * @param userId - User ID requesting access
 * @param sessionId - Session ID to check
 * @returns True if user can view session
 */
export async function canViewSession(
    userId: string,
    sessionId: string
): Promise<boolean> {
    const access = await checkSessionAccess(userId, sessionId);
    return access !== null;
}

/**
 * Check if user can send messages to session
 *
 * @param userId - User ID requesting access
 * @param sessionId - Session ID to check
 * @returns True if user can send messages
 */
export async function canSendMessages(
    userId: string,
    sessionId: string
): Promise<boolean> {
    const access = await checkSessionAccess(userId, sessionId);
    if (!access) return false;
    return requireAccessLevel(access, 'edit');
}

/**
 * Check if user can manage sharing settings
 *
 * @param userId - User ID requesting access
 * @param sessionId - Session ID to check
 * @returns True if user can manage sharing
 */
export async function canManageSharing(
    userId: string,
    sessionId: string
): Promise<boolean> {
    const access = await checkSessionAccess(userId, sessionId);
    if (!access) return false;
    return requireAccessLevel(access, 'admin');
}

/**
 * Check if user can approve permission prompts for this session.
 *
 * - Owners can always approve.
 * - Shared users can approve only if:
 *   - they have at least edit access, AND
 *   - their share has canApprovePermissions enabled.
 */
export async function canApprovePermissions(
    userId: string,
    sessionId: string,
): Promise<boolean> {
    const access = await checkSessionAccess(userId, sessionId);
    if (!access) return false;
    if (access.isOwner) return true;
    if (!requireAccessLevel(access, 'edit')) return false;

    const share = await db.sessionShare.findUnique({
        where: {
            sessionId_sharedWithUserId: {
                sessionId,
                sharedWithUserId: userId,
            },
        },
        select: { canApprovePermissions: true },
    });

    return share?.canApprovePermissions === true;
}

/**
 * Check if user can grant/revoke permission-approval capability for other recipients.
 *
 * - Owners can always manage delegation.
 * - Shared admins can manage delegation only if their own share also has canApprovePermissions enabled.
 *
 * This prevents shared admins (without delegated permission approval) from escalating privileges.
 */
export async function canManagePermissionDelegation(
    userId: string,
    sessionId: string,
): Promise<boolean> {
    const access = await checkSessionAccess(userId, sessionId);
    if (!access) return false;
    if (access.isOwner) return true;
    if (access.level !== 'admin') return false;

    const share = await db.sessionShare.findUnique({
        where: {
            sessionId_sharedWithUserId: {
                sessionId,
                sharedWithUserId: userId,
            },
        },
        select: { canApprovePermissions: true },
    });

    return share?.canApprovePermissions === true;
}

/**
 * Check if user owns the session
 *
 * @param userId - User ID requesting access
 * @param sessionId - Session ID to check
 * @returns True if user owns the session
 */
export async function isSessionOwner(
    userId: string,
    sessionId: string
): Promise<boolean> {
    const access = await checkSessionAccess(userId, sessionId);
    return access?.isOwner ?? false;
}

/**
 * Check if two users are friends
 *
 * @param userId1 - First user ID
 * @param userId2 - Second user ID
 * @returns True if users are friends
 */
export async function areFriends(
    userId1: string,
    userId2: string
): Promise<boolean> {
    const relationship = await db.userRelationship.findFirst({
        where: {
            OR: [
                { fromUserId: userId1, toUserId: userId2, status: 'friend' },
                { fromUserId: userId2, toUserId: userId1, status: 'friend' }
            ]
        }
    });
    return relationship !== null;
}
