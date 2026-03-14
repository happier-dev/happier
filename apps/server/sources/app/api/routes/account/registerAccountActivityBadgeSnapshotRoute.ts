import { z } from "zod";
import { type Fastify } from "../../types";
import { computeAccountActivityBadgeCounts } from "@/app/activity/accountActivityBadge";

export function registerAccountActivityBadgeSnapshotRoute(app: Fastify): void {
    app.get(
        "/v1/account/activity/badge-snapshot",
        {
            schema: {
                response: {
                    200: z.object({
                        badgeCount: z.number().int().nonnegative(),
                    }),
                },
            },
            preHandler: app.authenticate,
        },
        async (request, reply) => {
            const accountId = request.userId;
            const badgeCount = (await computeAccountActivityBadgeCounts([accountId])).get(accountId) ?? 0;

            return reply.send({ badgeCount });
        },
    );
}
