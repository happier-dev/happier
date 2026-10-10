import {
    HomeGovernanceErrorV1Schema,
    HomeReachabilityGetInputV1Schema,
    HomeReachabilityIrohSetInputV1Schema,
    HomeReachabilityV1Schema,
    homeGovernanceErrorHttpStatusV1,
} from "@happier-dev/protocol";

import { homeDomainActionPathForMethod } from "@/app/api/routes/actions/homeDomainActionRoute";
import { resolveApiHotEndpointRateLimit } from "@/app/api/utils/apiRateLimitCatalog";
import { authorizeHomeGovernanceMutationInTx } from "@/app/home/governance/homeCapabilities";
import { readHomeReachability, setHomeIrohMode } from "@/app/home/reachability/homeReachability";
import { readHomeConfigEnv } from "@/app/home/settings/homeSettings";
import { readRequestHomeEnv } from "@/app/home/settings/requestHomeEnv";
import { resolveInferredPublicServerAccess } from "@/app/integrations/publicUrl/publicServerUrlInference";
import { inTx } from "@/storage/inTx";

import type { Fastify } from "../../types";

const ERROR_RESPONSES = {
    400: HomeGovernanceErrorV1Schema,
    403: HomeGovernanceErrorV1Schema,
    404: HomeGovernanceErrorV1Schema,
    409: HomeGovernanceErrorV1Schema,
} as const;

const FORBIDDEN_STATUS = homeGovernanceErrorHttpStatusV1("home_governance_forbidden");

/**
 * How this Home is reached (plan `2026-09-26-home-owner-console` §3.2). The read needs
 * `viewAdministration`; turning direct connections on or off needs `manageHomeSettings` (owners).
 * The addresses themselves are Home settings written through `home.settings.set`.
 */
export function registerHomeReachabilityRoutes(app: Fastify): void {
    const SETTINGS_RATE_LIMIT = { rateLimit: resolveApiHotEndpointRateLimit(process.env, "account.settings") };
    app.post(
        homeDomainActionPathForMethod("home.reachability.get", "POST"),
        {
            preHandler: [app.authenticate],
            attachValidation: true,
            schema: { body: HomeReachabilityGetInputV1Schema, response: { 200: HomeReachabilityV1Schema, ...ERROR_RESPONSES } },
            config: SETTINGS_RATE_LIMIT,
        },
        async (request, reply) => {
            if (request.validationError) return await reply.code(400).send({ error: "invalid_home_input" as const });
            const admitted = await inTx(async (tx) => (await authorizeHomeGovernanceMutationInTx(tx, {
                actorAccountId: request.userId,
                request: { operation: "view" },
            })).status !== "rejected");
            if (!admitted) return await reply.code(FORBIDDEN_STATUS).send({ error: "home_governance_forbidden" as const });
            // Authentication may already have captured the settings. Reach waits for inference,
            // then updates only that read-only source through the same request/precedence owner.
            const access = await resolveInferredPublicServerAccess(await readRequestHomeEnv(request)).catch(() => null);
            const env = await readRequestHomeEnv(request, { inferred: access?.inferred ? { HAPPIER_PUBLIC_SERVER_URL: access.inferred.url } : {} });
            return await reply.send(await readHomeReachability({ env, access }));
        },
    );

    app.post(
        homeDomainActionPathForMethod("home.reachability.iroh.set", "POST"),
        {
            preHandler: [app.authenticate],
            attachValidation: true,
            schema: { body: HomeReachabilityIrohSetInputV1Schema, response: { 200: HomeReachabilityV1Schema, ...ERROR_RESPONSES } },
            config: SETTINGS_RATE_LIMIT,
        },
        async (request, reply) => {
            if (request.validationError) return await reply.code(400).send({ error: "invalid_home_input" as const });
            const env = await readRequestHomeEnv(request);
            const outcome = await setHomeIrohMode({ actorAccountId: request.userId, mode: request.body.mode, env });
            switch (outcome.status) {
                case "forbidden":
                    return await reply.code(FORBIDDEN_STATUS).send({ error: "home_governance_forbidden" as const });
                case "not_available":
                    return await reply
                        .code(homeGovernanceErrorHttpStatusV1("home_iroh_not_available"))
                        .send({ error: "home_iroh_not_available" as const });
                case "needs_public_address":
                    return await reply
                        .code(homeGovernanceErrorHttpStatusV1("home_iroh_needs_public_address"))
                        .send({ error: "home_iroh_needs_public_address" as const });
                case "revision_conflict":
                    return await reply
                        .code(homeGovernanceErrorHttpStatusV1("home_settings_revision_conflict"))
                        .send({ error: "home_settings_revision_conflict" as const });
                case "applied": {
                    // The mode was stored in this request, so read the overlay again for the answer.
                    const access = await resolveInferredPublicServerAccess(process.env).catch(() => null);
                    return await reply.send(await readHomeReachability({ env: await readHomeConfigEnv(), access }));
                }
            }
        },
    );
}
