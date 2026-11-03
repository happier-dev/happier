import { registerArtifactSignedInLinkRoutes } from './registerArtifactSignedInLinkRoutes';
import { type Fastify } from "../../types";
import { z } from "zod/mini";
import { assertSessionCapabilityInTx } from "@/app/session/access/sessionAccess";
import { ACCOUNT_DISPLAY_PROFILE_SELECT, toShareUserProfile } from "@/app/account/profile/accountDisplayProfile";
import { registerPublicShareOwnerRoutes } from "./registerPublicShareOwnerRoutes";
import { registerPublicShareReadRoutes } from "./registerPublicShareReadRoutes";
import { registerStoredContentPublicShareRoutes } from "./registerStoredContentPublicShareRoutes";
import { registerPublicShareViewerRoutes } from "./registerPublicShareViewerRoutes";
import { readSessionAccessAuthenticationFromRequest } from "@/app/session/access/sessionAccessAuthentication";
import { inReadSnapshot } from "@/storage/inTx";
import { createServerFeatureGatedRouteApp } from "@/app/features/catalog/serverFeatureGate";

/**
 * Public session sharing API routes
 *
 * Public shares are always view-only for security
 */
export function publicShareRoutes(app: Fastify): void {
    registerArtifactSignedInLinkRoutes(app);
    // `sharing.public` is the one availability owner for both authenticated
    // management and anonymous publication reads. Apply it to the complete route
    // family so build-policy denial cannot leave a hidden-but-callable endpoint.
    // The wrapper prepends the gate and preserves each route's auth prehandlers.
    const routes = createServerFeatureGatedRouteApp(app, "sharing.public");
    registerPublicShareOwnerRoutes(routes);
    registerPublicShareReadRoutes(routes);
    registerStoredContentPublicShareRoutes(routes);
    registerPublicShareViewerRoutes(routes);

    /**
     * Get access logs for public share
     */
    routes.get('/v1/sessions/:sessionId/public-share/access-logs', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                sessionId: z.string()
            }),
            querystring: z.optional(z.object({
                limit: z._default(z.coerce.number().check(z.int(), z.minimum(1), z.maximum(100)), 50)
            }))
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId } = request.params;
        const limit = request.query?.limit || 50;

        const result = await inReadSnapshot(async (tx) => {
            const authority = await assertSessionCapabilityInTx({
                tx,
                accountId: userId,
                sessionId,
                capability: "managePublicLink",
                authentication: readSessionAccessAuthenticationFromRequest(request),
            });
            if (!authority.ok) return { type: "forbidden" as const, reason: authority.reason };

            const publicShare = await tx.publicSessionShare.findUnique({
                where: { sessionId },
                select: { id: true },
            });
            if (!publicShare) return { type: "not-found" as const };

            const logs = await tx.publicShareAccessLog.findMany({
                where: { publicShareId: publicShare.id },
                include: {
                    user: {
                        select: ACCOUNT_DISPLAY_PROFILE_SELECT,
                    },
                },
                orderBy: { accessedAt: 'desc' },
                take: limit,
            });
            return { type: "ok" as const, logs };
        });

        if (result.type === "forbidden") {
            if (result.reason === "authentication_unavailable") {
                return reply.code(503).send({ error: "session_access_authentication_unavailable" });
            }
            return reply.code(403).send({
                error: result.reason === "authentication_required"
                    ? "session_access_authentication_required"
                    : "session_access_forbidden",
            });
        }
        if (result.type === "not-found") {
            return reply.code(404).send({ error: 'Public share not found' });
        }

        return reply.send({
            logs: result.logs.map(log => ({
                id: log.id,
                user: log.user ? toShareUserProfile(log.user) : null,
                accessedAt: log.accessedAt.getTime(),
                ipAddress: log.ipAddress,
                userAgent: log.userAgent
            }))
        });
    });
}
