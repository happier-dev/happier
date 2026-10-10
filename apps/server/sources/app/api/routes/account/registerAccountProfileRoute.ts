import { getPublicUrl } from "@/storage/blob/files";
import { fetchLinkedProvidersForAccount } from "@/app/auth/providers/linkedProviders";
import { type Fastify } from "../../types";
import { isServerFeatureEnabledForRequest } from "@/app/features/catalog/serverFeatureGate";
import { resolveApiHotEndpointRateLimit } from "@/app/api/utils/apiRateLimitCatalog";
import { buildAccountConnectedServicesProjection } from "./connectedServicesProjection";
import { inTx } from "@/storage/inTx";
import { buildLinkedIdentityManagementProjectionInTx } from "@/app/auth/providers/accountLinkedIdentityManagement";
import { readRequestHomeEnv } from "@/app/home/settings/requestHomeEnv";

export function registerAccountProfileRoute(app: Fastify): void {
    app.get('/v1/account/profile', {
        preHandler: app.authenticate,
        config: {
            rateLimit: resolveApiHotEndpointRateLimit(process.env, "account.profile"),
        },
    }, async (request, reply) => {
        const requestHomeEnv = await readRequestHomeEnv(request);
        const userId = request.userId;
        const connectedServiceAccountGroupsEnabled = isServerFeatureEnabledForRequest("connectedServices.accountGroups", requestHomeEnv);
        const { user, connectedServiceProjection, linkedProviders, linkedIdentityManagementV1 } = await inTx(async tx => {
            const user = await tx.account.findUniqueOrThrow({
                where: { id: userId },
                select: {
                    firstName: true,
                    lastName: true,
                    username: true,
                    avatar: true,
                }
            });

            const connectedServiceProjection = await buildAccountConnectedServicesProjection({
                tx,
                accountId: userId,
                includeGroups: connectedServiceAccountGroupsEnabled,
            });
            const [currentLinkedProviders, currentManagement] = await Promise.all([
                fetchLinkedProvidersForAccount({ tx, accountId: userId }),
                buildLinkedIdentityManagementProjectionInTx(tx, { accountId: userId, env: requestHomeEnv }),
            ]);
            return {
                user,
                connectedServiceProjection,
                linkedProviders: currentLinkedProviders,
                linkedIdentityManagementV1: currentManagement,
            };
        }, { readOnly: true });
        return reply.send({
            id: userId,
            timestamp: Date.now(),
            firstName: user.firstName,
            lastName: user.lastName,
            username: user.username,
            avatar: user.avatar ? { ...user.avatar, url: getPublicUrl(user.avatar.path) } : null,
            linkedProviders,
            linkedIdentityManagementV1,
            connectedServices: connectedServiceProjection.connectedServices,
            connectedServicesV2: connectedServiceProjection.connectedServicesV2,
            connectedServiceCredentialRevisionsV1: connectedServiceProjection.connectedServiceCredentialRevisionsV1,
            connectedAccountsV4: connectedServiceProjection.connectedAccountsV4,
            connectedAccountGroupsV4: connectedServiceProjection.connectedAccountGroupsV4,
        });
    });
}
