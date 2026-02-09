import { z } from "zod";
import { buildUpdateAccountUpdate, eventRouter } from "@/app/events/eventRouter";
import { randomKeyNaked } from "@/utils/keys/randomKeyNaked";
import { afterTx, inTx } from "@/storage/inTx";
import { markAccountChanged } from "@/app/changes/markAccountChanged";
import { fetchLinkedProvidersForAccount } from "@/app/auth/providers/linkedProviders";
import { findIdentityProviderById } from "@/app/auth/providers/identityProviders/registry";
import { type Fastify } from "../../types";

export function registerAccountIdentityVisibilityRoute(app: Fastify): void {
    app.patch('/v1/account/identity/:provider', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ provider: z.string() }),
            body: z.object({ showOnProfile: z.boolean() }),
            response: {
                200: z.object({ success: z.literal(true) }),
                404: z.object({ error: z.enum(['unsupported-provider', 'not-connected']) }),
            },
        },
    }, async (request, reply) => {
        const providerId = request.params.provider.toString().trim().toLowerCase();
        const provider = findIdentityProviderById(process.env, providerId);
        if (!provider) return reply.code(404).send({ error: 'unsupported-provider' });

        const result = await inTx(async (tx) => {
            const { count } = await tx.accountIdentity.updateMany({
                where: { accountId: request.userId, provider: providerId },
                data: { showOnProfile: request.body.showOnProfile },
            });

            if (count === 0) {
                return { type: "not-connected" as const };
            }

            const linkedProviders = await fetchLinkedProvidersForAccount({ tx: tx as any, accountId: request.userId });
            const cursor = await markAccountChanged(tx, {
                accountId: request.userId,
                kind: "account",
                entityId: "self",
                hint: { linkedProviders: true },
            });

            afterTx(tx, () => {
                const updatePayload = buildUpdateAccountUpdate(
                    request.userId,
                    { linkedProviders },
                    cursor,
                    randomKeyNaked(12),
                );
                eventRouter.emitUpdate({
                    userId: request.userId,
                    payload: updatePayload,
                    recipientFilter: { type: "user-scoped-only" },
                });
            });

            return { type: "ok" as const };
        });

        if (result.type === "not-connected") {
            return reply.code(404).send({ error: "not-connected" });
        }

        return reply.send({ success: true });
    });
}
