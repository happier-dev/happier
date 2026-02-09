import { type Fastify } from "../../types";
import { db } from "@/storage/db";
import { z } from "zod";
import { isSessionOwner } from "@/app/share/accessControl";
import { PROFILE_SELECT, toShareUserProfile } from "@/app/share/types";
import { registerPublicShareOwnerRoutes } from "./registerPublicShareOwnerRoutes";
import { registerPublicShareReadRoutes } from "./registerPublicShareReadRoutes";

/**
 * Public session sharing API routes
 *
 * Public shares are always view-only for security
 */
export function publicShareRoutes(app: Fastify): void {
    registerPublicShareOwnerRoutes(app);
    registerPublicShareReadRoutes(app);

    /**
     * Get blocked users for public share
     */
    app.get('/v1/sessions/:sessionId/public-share/blocked-users', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                sessionId: z.string()
            })
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId } = request.params;

        // Only owner can view blocked users
        if (!await isSessionOwner(userId, sessionId)) {
            return reply.code(403).send({ error: 'Forbidden' });
        }

        const publicShare = await db.publicSessionShare.findUnique({
            where: { sessionId },
            select: { id: true }
        });

        if (!publicShare) {
            return reply.code(404).send({ error: 'Public share not found' });
        }

        const blockedUsers = await db.publicShareBlockedUser.findMany({
            where: { publicShareId: publicShare.id },
            include: {
                user: {
                    select: PROFILE_SELECT
                }
            },
            orderBy: { blockedAt: 'desc' }
        });

        return reply.send({
            blockedUsers: blockedUsers.map(bu => ({
                id: bu.id,
                user: toShareUserProfile(bu.user),
                reason: bu.reason,
                blockedAt: bu.blockedAt.getTime()
            }))
        });
    });

    /**
     * Block user from public share
     */
    app.post('/v1/sessions/:sessionId/public-share/blocked-users', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                sessionId: z.string()
            }),
            body: z.object({
                userId: z.string(),
                reason: z.string().optional()
            })
        }
    }, async (request, reply) => {
        const ownerId = request.userId;
        const { sessionId } = request.params;
        const { userId, reason } = request.body;

        // Only owner can block users
        if (!await isSessionOwner(ownerId, sessionId)) {
            return reply.code(403).send({ error: 'Forbidden' });
        }

        const publicShare = await db.publicSessionShare.findUnique({
            where: { sessionId },
            select: { id: true }
        });

        if (!publicShare) {
            return reply.code(404).send({ error: 'Public share not found' });
        }

        const blockedUser = await db.publicShareBlockedUser.create({
            data: {
                publicShareId: publicShare.id,
                userId,
                reason: reason ?? null
            },
            include: {
                user: {
                    select: PROFILE_SELECT
                }
            }
        });

        return reply.send({
            blockedUser: {
                id: blockedUser.id,
                user: toShareUserProfile(blockedUser.user),
                reason: blockedUser.reason,
                blockedAt: blockedUser.blockedAt.getTime()
            }
        });
    });

    /**
     * Unblock user from public share
     */
    app.delete('/v1/sessions/:sessionId/public-share/blocked-users/:blockedUserId', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                sessionId: z.string(),
                blockedUserId: z.string()
            })
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId, blockedUserId } = request.params;

        // Only owner can unblock users
        if (!await isSessionOwner(userId, sessionId)) {
            return reply.code(403).send({ error: 'Forbidden' });
        }

        await db.publicShareBlockedUser.delete({
            where: { id: blockedUserId }
        });

        return reply.send({ success: true });
    });

    /**
     * Get access logs for public share
     */
    app.get('/v1/sessions/:sessionId/public-share/access-logs', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                sessionId: z.string()
            }),
            querystring: z.object({
                limit: z.coerce.number().int().min(1).max(100).default(50)
            }).optional()
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId } = request.params;
        const limit = request.query?.limit || 50;

        // Only owner can view access logs
        if (!await isSessionOwner(userId, sessionId)) {
            return reply.code(403).send({ error: 'Forbidden' });
        }

        const publicShare = await db.publicSessionShare.findUnique({
            where: { sessionId },
            select: { id: true }
        });

        if (!publicShare) {
            return reply.code(404).send({ error: 'Public share not found' });
        }

        const logs = await db.publicShareAccessLog.findMany({
            where: { publicShareId: publicShare.id },
            include: {
                user: {
                    select: PROFILE_SELECT
                }
            },
            orderBy: { accessedAt: 'desc' },
            take: limit
        });

        return reply.send({
            logs: logs.map(log => ({
                id: log.id,
                user: log.user ? toShareUserProfile(log.user) : null,
                accessedAt: log.accessedAt.getTime(),
                ipAddress: log.ipAddress,
                userAgent: log.userAgent
            }))
        });
    });
}
