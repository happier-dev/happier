import { AccountPlanResponseV1Schema, readServerEnabledBit } from "@happier-dev/protocol";
import { z } from "zod/mini";

import type { Fastify } from "@/app/api/types";
import { resolveServerFeaturesForGating } from "@/app/features/catalog/serverFeatureGate";
import { inReadSnapshot } from "@/storage/inTx";
import { readSessionAccessAuthenticationFromRequest } from "@/app/session/access/sessionAccessAuthentication";
import { readRequestHomeEnv } from "@/app/home/settings/requestHomeEnv";

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
        const env = await readRequestHomeEnv(request);
        const features = resolveServerFeaturesForGating(env);
        const bits = {
            plans: readServerEnabledBit(features, "plans") === true,
            supporter: readServerEnabledBit(features, "supporter") === true,
        };
        if (!bits.plans && !bits.supporter) return reply.code(404).send({ error: "not_found" });
        const authentication = readSessionAccessAuthenticationFromRequest(request);
        const response = await inReadSnapshot(tx => readAccountPlanInTx(tx, {
            accountId: request.userId, env, bits, authentication,
        }));
        if (!response) return reply.code(404).send({ error: "not_found" });
        return reply.send(response);
    });
}
