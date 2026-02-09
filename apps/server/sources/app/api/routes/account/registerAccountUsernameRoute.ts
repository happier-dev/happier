import { z } from "zod";
import { db } from "@/storage/db";
import { Context } from "@/context";
import { UsernameTakenError, usernameUpdate } from "@/app/social/usernameUpdate";
import { resolveFriendsPolicyFromEnv } from "@/app/social/friendsPolicy";
import { validateUsername } from "@/app/social/usernamePolicy";
import { type Fastify } from "../../types";

export function registerAccountUsernameRoute(app: Fastify): void {
    app.post('/v1/account/username', {
        preHandler: app.authenticate,
        schema: {
            body: z.object({
                username: z.string(),
            }),
            response: {
                200: z.object({ username: z.string() }),
                400: z.object({ error: z.enum(['invalid-username', 'username-disabled', 'friends-disabled']) }),
                409: z.object({ error: z.literal('username-taken') }),
            },
        },
    }, async (request, reply) => {
        const friendsPolicy = resolveFriendsPolicyFromEnv(process.env);
        if (!friendsPolicy.enabled) {
            return reply.code(400).send({ error: 'friends-disabled' });
        }
        if (!friendsPolicy.allowUsername) {
            if (!friendsPolicy.requiredIdentityProviderId) {
                return reply.code(400).send({ error: 'username-disabled' });
            }
            const current = await db.account.findUnique({
                where: { id: request.userId },
                select: {
                    AccountIdentity: {
                        where: { provider: friendsPolicy.requiredIdentityProviderId },
                        select: { id: true },
                        take: 1,
                    },
                },
            });
            if (!current || current.AccountIdentity.length === 0) {
                return reply.code(400).send({ error: 'username-disabled' });
            }
        }

        const validation = validateUsername(request.body.username, process.env);
        if (!validation.ok) {
            return reply.code(400).send({ error: 'invalid-username' });
        }
        const username = validation.username;

        // Fast pre-check for friendlier errors; rely on unique index as final arbiter.
        const existing = await db.account.findFirst({
            where: {
                username,
                NOT: { id: request.userId },
            },
            select: { id: true },
        });
        if (existing) {
            return reply.code(409).send({ error: 'username-taken' });
        }

        try {
            await usernameUpdate(Context.create(request.userId), username);
        } catch (e) {
            if (e instanceof UsernameTakenError) {
                return reply.code(409).send({ error: 'username-taken' });
            }
            throw e;
        }

        return reply.send({ username });
    });
}
