import { getPublicUrl } from "@/storage/blob/files";
import { fetchLinkedProvidersForAccount } from "@/app/auth/providers/linkedProviders";
import { type Fastify } from "../../types";
import { isServerFeatureEnabledForRequest } from "@/app/features/catalog/serverFeatureGate";
import { resolveApiHotEndpointRateLimit } from "@/app/api/utils/apiRateLimitCatalog";
import { buildAccountConnectedServicesProjection } from "./connectedServicesProjection";
import { afterTx, inReadSnapshot, inTx, transactionResult } from "@/storage/inTx";
import { buildLinkedIdentityManagementProjectionInTx } from "@/app/auth/providers/accountLinkedIdentityManagement";
import { readRequestHomeEnv } from "@/app/home/settings/requestHomeEnv";
import { AccountNameUpdateRequestV1Schema, AccountNameUpdateResponseV1Schema } from "@happier-dev/protocol/account/profile";
import { projectAccountNameToLegacyFieldsV1 } from '@happier-dev/protocol/account/accountDisplayProfileV1';
import { acquireAccountChangePublicationLocksInTx, enqueueAccountChangePublication, markAccountChanged } from "@/app/changes/markAccountChanged";
import { buildUpdateAccountUpdate, eventRouter } from "@/app/events/eventRouter";
import { randomKeyNaked } from "@/utils/keys/randomKeyNaked";

export function registerAccountProfileRoute(app: Fastify): void {
    app.post('/v1/account/profile', {
        preHandler: app.authenticate,
        config: { rateLimit: resolveApiHotEndpointRateLimit(process.env, "account.profile") },
        schema: {
            body: AccountNameUpdateRequestV1Schema,
            response: { 200: AccountNameUpdateResponseV1Schema },
        },
    }, async (request, reply) => {
        const name = await inTx(async (tx) => {
            await acquireAccountChangePublicationLocksInTx(tx, [request.userId], { includeSingleAccount: true });
            let updatedName = request.body.name;
            enqueueAccountChangePublication(tx, [request.userId], async publicationTx => {
                // Compare only under the terminal Account writer fence so
                // concurrent equal replacements publish a single real change.
                const current = await publicationTx.account.findUniqueOrThrow({
                    where: { id: request.userId },
                    select: { name: true },
                });
                if (current.name === request.body.name) return;
                const account = await publicationTx.account.update({
                    where: { id: request.userId },
                    data: { name: request.body.name },
                    select: { name: true },
                });
                updatedName = account.name;
                const cursor = await markAccountChanged(publicationTx, {
                    accountId: request.userId, kind: 'account', entityId: 'self', hint: { name: true },
                });
                afterTx(publicationTx, () => eventRouter.emitUpdate({
                    userId: request.userId,
                    payload: buildUpdateAccountUpdate(request.userId, { name: updatedName }, cursor.resolveCursor(), randomKeyNaked(12)),
                    recipientFilter: { type: 'user-scoped-only' },
                }));
            });
            return transactionResult(() => updatedName);
        });
        return reply.send({ name, ...projectAccountNameToLegacyFieldsV1(name), timestamp: Date.now() });
    });
    app.get('/v1/account/profile', {
        preHandler: app.authenticate,
        config: {
            rateLimit: resolveApiHotEndpointRateLimit(process.env, "account.profile"),
        },
    }, async (request, reply) => {
        const requestHomeEnv = await readRequestHomeEnv(request);
        const userId = request.userId;
        const connectedServiceAccountGroupsEnabled = isServerFeatureEnabledForRequest("connectedServices.accountGroups", requestHomeEnv);
        const { user, connectedServiceProjection, linkedProviders, linkedIdentityManagementV1 } = await inReadSnapshot(async tx => {
            const user = await tx.account.findUniqueOrThrow({
                where: { id: userId },
                select: {
                    name: true,
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
        });
        return reply.send({
            id: userId,
            timestamp: Date.now(),
            name: user.name,
            ...projectAccountNameToLegacyFieldsV1(user.name),
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
