import { db } from "@/storage/db";

type PublicShareAccessLogWriter = Pick<typeof db, "publicShareAccessLog">;

/**
 * Log access to a direct session share
 *
 * @param sessionShareId - Session share ID
 * @param userId - User ID who accessed
 * @param ipAddress - IP address (optional)
 * @param userAgent - User agent (optional)
 */
export async function logSessionShareAccess(
    sessionShareId: string,
    userId: string,
    ipAddress?: string,
    userAgent?: string
): Promise<void> {
    await db.sessionShareAccessLog.create({
        data: {
            sessionShareId,
            userId,
            ipAddress: ipAddress ?? null,
            userAgent: userAgent ?? null
        }
    });
}

/**
 * Log access to a public session share
 *
 * @param publicShareId - Public share ID
 * @param userId - User ID who accessed (null for anonymous)
 * @param ipAddress - IP address (optional)
 * @param userAgent - User agent (optional)
 */
export async function logPublicShareAccess(
    publicShareId: string,
    userId: string | null,
    ipAddress?: string,
    userAgent?: string,
    writer: PublicShareAccessLogWriter = db,
): Promise<void> {
    await writer.publicShareAccessLog.create({
        data: {
            publicShareId,
            userId: userId ?? null,
            ipAddress: ipAddress ?? null,
            userAgent: userAgent ?? null
        }
    });
}

/**
 * Get user agent from request
 *
 * @param headers - Request headers
 * @returns User agent or undefined
 */
export function getUserAgent(headers: Record<string, string | string[] | undefined>): string | undefined {
    const userAgent = headers['user-agent'];
    if (!userAgent) return undefined;
    return Array.isArray(userAgent) ? userAgent[0] : userAgent;
}
