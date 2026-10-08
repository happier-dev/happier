import { db } from "@/storage/db";
import { ANTIGRAVITY_ACCOUNT_PROFILE_ACCEPT } from '@happier-dev/protocol';
import { getPublicUrl } from "@/storage/blob/files";
import { fetchLinkedProvidersForAccount } from "@/app/auth/providers/linkedProviders";
import { type Fastify } from "../../types";
import { resolveApiHotEndpointRateLimit } from "@/app/api/utils/apiRateLimitCatalog";
import {
    buildAccountConnectedServicesProjection,
    type ConnectedServicesProjectionClient,
} from "./connectedServicesProfileProjection";

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

        const connectedServicesProjection = await buildAccountConnectedServicesProjection({
            tx: db as unknown as ConnectedServicesProjectionClient,
            accountId: userId,
            includeAntigravity: request.headers.accept === ANTIGRAVITY_ACCOUNT_PROFILE_ACCEPT,
        });
        const linkedProviders = await fetchLinkedProvidersForAccount({ tx: db as any, accountId: userId });
        return reply.send({
            id: userId,
            timestamp: Date.now(),
            firstName: user.firstName,
            lastName: user.lastName,
            username: user.username,
            avatar: user.avatar ? { ...user.avatar, url: getPublicUrl(user.avatar.path) } : null,
            linkedProviders,
            connectedServices: connectedServicesProjection.connectedServices,
            connectedServicesV2: connectedServicesProjection.connectedServicesV2,
            connectedServiceCredentialRevisionsV1: connectedServicesProjection.connectedServiceCredentialRevisionsV1,
        });
    });
}
