import { db } from "@/storage/db";
import { getPublicUrl } from "@/storage/blob/files";
import { fetchLinkedProvidersForAccount } from "@/app/auth/providers/linkedProviders";
import { type Fastify } from "../../types";
import { isServerFeatureEnabledForRequest } from "@/app/features/catalog/serverFeatureGate";
import { resolveApiHotEndpointRateLimit } from "@/app/api/utils/apiRateLimitCatalog";
import { buildAccountConnectedServicesProjection } from "./connectedServicesProjection";

export function registerAccountProfileRoute(app: Fastify): void {
    app.get('/v1/account/profile', {
        preHandler: app.authenticate,
        config: {
            rateLimit: resolveApiHotEndpointRateLimit(process.env, "account.profile"),
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const user = await db.account.findUniqueOrThrow({
            where: { id: userId },
            select: {
                firstName: true,
                lastName: true,
                username: true,
                avatar: true,
            }
        });

        const connectedServicesEnabled = isServerFeatureEnabledForRequest("connectedServices", process.env);
        const connectedServiceAccountGroupsEnabled = isServerFeatureEnabledForRequest("connectedServices.accountGroups", process.env);

        const connectedServiceProjection = connectedServicesEnabled
            ? await buildAccountConnectedServicesProjection({
                tx: db,
                accountId: userId,
                includeGroups: connectedServiceAccountGroupsEnabled,
            })
            : { connectedServices: [], connectedServicesV2: [] };
        const linkedProviders = await fetchLinkedProvidersForAccount({ tx: db as any, accountId: userId });
        return reply.send({
            id: userId,
            timestamp: Date.now(),
            firstName: user.firstName,
            lastName: user.lastName,
            username: user.username,
            avatar: user.avatar ? { ...user.avatar, url: getPublicUrl(user.avatar.path) } : null,
            linkedProviders,
            connectedServices: connectedServiceProjection.connectedServices,
            connectedServicesV2: connectedServiceProjection.connectedServicesV2,
        });
    });
}
