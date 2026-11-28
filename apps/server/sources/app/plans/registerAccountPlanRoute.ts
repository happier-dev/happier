import { AccountPlanResponseV1Schema, readServerEnabledBit } from "@happier-dev/protocol";
import { z } from "zod";

import type { Fastify } from "@/app/api/types";
import { resolveServerFeaturesForGating } from "@/app/features/catalog/serverFeatureGate";
import { db } from "@/storage/db";

import { readAccountPlanInTx } from "./readAccountPlan";

/**
 * `GET /v1/account/plan`: the session's plan, limits, usage, supporter facts and offers.
 * 404 unless the `plans` or `supporter` bit is on, so a server that hides both answers nothing.
 * Read on page open and on the plan change hint only; never at boot, never polled.
 */
export function registerAccountPlanRoute(app: Fastify): void {
    app.get("/v1/account/plan", {
        preHandler: app.authenticate,
        schema: {
            response: {
                200: AccountPlanResponseV1Schema,
                404: z.object({ error: z.literal("not_found") }),
            },
        },
    }, async (request, reply) => {
        const features = resolveServerFeaturesForGating(process.env);
        const bits = {
            plans: readServerEnabledBit(features, "plans") === true,
            supporter: readServerEnabledBit(features, "supporter") === true,
        };
        if (!bits.plans && !bits.supporter) return reply.code(404).send({ error: "not_found" });
        const response = await readAccountPlanInTx(db, { accountId: request.userId, env: process.env, bits });
        if (!response) return reply.code(404).send({ error: "not_found" });
        return reply.send(response);
    });
}
