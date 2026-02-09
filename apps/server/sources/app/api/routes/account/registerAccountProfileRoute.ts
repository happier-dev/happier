import { db } from "@/storage/db";
import { getPublicUrl } from "@/storage/blob/files";
import { fetchLinkedProvidersForAccount } from "@/app/auth/providers/linkedProviders";
import { type Fastify } from "../../types";

export function registerAccountProfileRoute(app: Fastify): void {
    app.get('/v1/account/profile', {
        preHandler: app.authenticate,
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
        const connectedVendors = new Set((await db.serviceAccountToken.findMany({ where: { accountId: userId } })).map(t => t.vendor));
        const linkedProviders = await fetchLinkedProvidersForAccount({ tx: db as any, accountId: userId });
        return reply.send({
            id: userId,
            timestamp: Date.now(),
            firstName: user.firstName,
            lastName: user.lastName,
            username: user.username,
            avatar: user.avatar ? { ...user.avatar, url: getPublicUrl(user.avatar.path) } : null,
            linkedProviders,
            connectedServices: Array.from(connectedVendors)
        });
    });
}
