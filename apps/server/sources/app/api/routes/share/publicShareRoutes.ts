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
