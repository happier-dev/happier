import {
    HomeGovernanceErrorV1Schema,
    HomeRetentionDryRunInputV1Schema,
    HomeRetentionDryRunResultV1Schema,
    homeGovernanceErrorHttpStatusV1,
} from "@happier-dev/protocol";

import { homeDomainActionPathForMethod } from "@/app/api/routes/actions/homeDomainActionRoute";
import { resolveApiHotEndpointRateLimit } from "@/app/api/utils/apiRateLimitCatalog";
import { authorizeHomeGovernanceMutationInTx } from "@/app/home/governance/homeCapabilities";
import { readRequestHomeEnv } from "@/app/home/settings/requestHomeEnv";
import { runRetentionDryRun } from "@/app/retention/runtime/runRetentionDryRun";
import { inTx } from "@/storage/inTx";

import type { Fastify } from "../../types";

/**
 * `home.retention.dryRun` (plan `2026-09-26-home-owner-console` §3.6): owners only
 * (`manageHomeSettings`). The Home's effective rules come from the request overlay; the sweep, its
 * lock and its budget belong to `runRetentionDryRun`. Read-only, so not audited.
 */
export function registerHomeRetentionRoutes(app: Fastify): void {
    // Resolve restart configuration at registration, after the Home startup overlay.
    const RATE_LIMIT = { rateLimit: resolveApiHotEndpointRateLimit(process.env, "account.settings") };
    app.post(
        homeDomainActionPathForMethod("home.retention.dryRun", "POST"),
        {
            preHandler: [app.authenticate],
            attachValidation: true,
            schema: {
                body: HomeRetentionDryRunInputV1Schema,
                response: {
                    200: HomeRetentionDryRunResultV1Schema,
                    400: HomeGovernanceErrorV1Schema,
                    403: HomeGovernanceErrorV1Schema,
                    404: HomeGovernanceErrorV1Schema,
                    409: HomeGovernanceErrorV1Schema,
                },
            },
            config: RATE_LIMIT,
        },
        async (request, reply) => {
            if (request.validationError) return await reply.code(400).send({ error: "invalid_home_input" as const });
            // Read before any transaction: SQLite runs one connection.
            const requestHomeEnv = await readRequestHomeEnv(request);
            const authorization = await inTx(async (tx) => await authorizeHomeGovernanceMutationInTx(tx, {
                actorAccountId: request.userId,
                request: { operation: "manage_home_settings" },
            }));
            if (authorization.status === "rejected") {
                return await reply
                    .code(homeGovernanceErrorHttpStatusV1("home_governance_forbidden"))
                    .send({ error: "home_governance_forbidden" as const });
            }
            const outcome = await runRetentionDryRun({ env: requestHomeEnv });
            if (outcome.status === "in_progress") {
                return await reply
                    .code(homeGovernanceErrorHttpStatusV1("retention_sweep_in_progress"))
                    .send({ error: "retention_sweep_in_progress" as const });
            }
            return await reply.send(outcome.result);
        },
    );
}
