import {
    HomeAuditListInputV1Schema,
    HomeAuditListResultV1Schema,
    HomeGovernanceErrorV1Schema,
    HomeMailDeliveryGetInputV1Schema,
    HomeMailDeliveryReadinessV1Schema,
    HomeMailDeliveryTestInputV1Schema,
    HomeMailDeliveryTestResultV1Schema,
    HomeSettingsGetInputV1Schema,
    HomeSettingsInvalidErrorV1Schema,
    HomeSettingsProjectionV1Schema,
    HomeSettingsSetInputV1Schema,
    homeGovernanceErrorHttpStatusV1,
    normalizeVerifiedEmail,
} from "@happier-dev/protocol";
import { z } from "zod";

import { homeDomainActionPathForMethod } from "@/app/api/routes/actions/homeDomainActionRoute";
import { resolveApiHotEndpointRateLimit } from "@/app/api/utils/apiRateLimitCatalog";
import type { AuthEmailDelivery } from "@/app/auth/email/authEmailDelivery";
import { readAuthEmailReadinessFacts } from "@/app/auth/email/resolveAuthEmailDelivery";
import { listHomeAdministrationEventsInTx } from "@/app/home/audit/homeAdministrationEvents";
import { authorizeHomeGovernanceMutationInTx } from "@/app/home/governance/homeCapabilities";
import {
    isHomeSettingSecretUnreadable,
    readHomeSettingsInTx,
    readHomeSettingsProjectionInTx,
    setHomeSettings,
} from "@/app/home/settings/homeSettings";
import { readRequestHomeEnv } from "@/app/home/settings/requestHomeEnv";
import { resolveJoinScreenHomeDisplayName } from "@/app/teams/invitations/joinScreenHome";
import { inTx } from "@/storage/inTx";

import type { Fastify } from "../../types";


const ERROR_RESPONSES = {
    400: z.union([HomeGovernanceErrorV1Schema, HomeSettingsInvalidErrorV1Schema]),
    403: HomeGovernanceErrorV1Schema,
    404: HomeGovernanceErrorV1Schema,
    409: HomeGovernanceErrorV1Schema,
} as const;

const PASSWORD_KEY = "HAPPIER_AUTH_EMAIL_SMTP_PASSWORD";
const FORBIDDEN_STATUS = homeGovernanceErrorHttpStatusV1("home_governance_forbidden");

/**
 * Home settings, mail delivery and the administration audit trail (plan
 * `2026-09-26-home-owner-console` §3.3, §3.9, §3.14). Reads need `viewAdministration`; writes and
 * the test send need `manageHomeSettings` (owners). Every decision is made by the owners these
 * routes call; the routes only authenticate, validate and map results.
 */
export function registerHomeSettingsRoutes(app: Fastify, deps: Readonly<{ authEmailDelivery: AuthEmailDelivery }>): void {
    const SETTINGS_RATE_LIMIT = { rateLimit: resolveApiHotEndpointRateLimit(process.env, "account.settings") };
    const MAIL_TEST_RATE_LIMIT = { rateLimit: resolveApiHotEndpointRateLimit(process.env, "home.mailDelivery.test") };
    app.post(
        homeDomainActionPathForMethod("home.settings.get", "POST"),
        {
            preHandler: [app.authenticate],
            attachValidation: true,
            schema: { body: HomeSettingsGetInputV1Schema, response: { 200: HomeSettingsProjectionV1Schema, ...ERROR_RESPONSES } },
            config: SETTINGS_RATE_LIMIT,
        },
        async (request, reply) => {
            if (request.validationError) return await reply.code(400).send({ error: "invalid_home_input" as const });
            const read = await inTx(async (tx) => await readHomeSettingsProjectionInTx(tx, { actorAccountId: request.userId }));
            if (read.status === "forbidden") return await reply.code(FORBIDDEN_STATUS).send({ error: "home_governance_forbidden" as const });
            return await reply.send(read.projection);
        },
    );

    app.post(
        homeDomainActionPathForMethod("home.settings.set", "POST"),
        {
            preHandler: [app.authenticate],
            attachValidation: true,
            schema: { body: HomeSettingsSetInputV1Schema, response: { 200: HomeSettingsProjectionV1Schema, ...ERROR_RESPONSES } },
            config: SETTINGS_RATE_LIMIT,
        },
        async (request, reply) => {
            if (request.validationError) return await reply.code(400).send({ error: "invalid_home_input" as const });
            const outcome = await setHomeSettings({ actorAccountId: request.userId, write: request.body });
            switch (outcome.status) {
                case "forbidden":
                    return await reply.code(FORBIDDEN_STATUS).send({ error: "home_governance_forbidden" as const });
                case "revision_conflict":
                    return await reply
                        .code(homeGovernanceErrorHttpStatusV1("home_settings_revision_conflict"))
                        .send({ error: "home_settings_revision_conflict" as const });
                case "invalid":
                    return await reply.code(400).send({ error: "home_settings_invalid" as const, key: outcome.key, reason: outcome.reason });
                case "invalid_input":
                    return await reply.code(400).send({ error: "invalid_home_input" as const });
                case "applied":
                    return await reply.send(outcome.projection);
            }
        },
    );

    app.post(
        homeDomainActionPathForMethod("home.mailDelivery.get", "POST"),
        {
            preHandler: [app.authenticate],
            attachValidation: true,
            schema: { body: HomeMailDeliveryGetInputV1Schema, response: { 200: HomeMailDeliveryReadinessV1Schema, ...ERROR_RESPONSES } },
            config: SETTINGS_RATE_LIMIT,
        },
        async (request, reply) => {
            if (request.validationError) return await reply.code(400).send({ error: "invalid_home_input" as const });
            const read = await inTx(async (tx) => {
                const authorization = await authorizeHomeGovernanceMutationInTx(tx, {
                    actorAccountId: request.userId,
                    request: { operation: "view" },
                });
                if (authorization.status === "rejected") return null;
                return { passwordUnreadable: isHomeSettingSecretUnreadable(await readHomeSettingsInTx(tx), PASSWORD_KEY) };
            });
            if (!read) return await reply.code(FORBIDDEN_STATUS).send({ error: "home_governance_forbidden" as const });
            const facts = await readAuthEmailReadinessFacts(await readRequestHomeEnv(request));
            return await reply.send({ ...facts, passwordUnreadable: read.passwordUnreadable });
        },
    );

    app.post(
        homeDomainActionPathForMethod("home.mailDelivery.test", "POST"),
        {
            preHandler: [app.authenticate],
            attachValidation: true,
            schema: { body: HomeMailDeliveryTestInputV1Schema, response: { 200: HomeMailDeliveryTestResultV1Schema, ...ERROR_RESPONSES } },
            config: MAIL_TEST_RATE_LIMIT,
        },
        async (request, reply) => {
            if (request.validationError) return await reply.code(400).send({ error: "invalid_home_input" as const });
            const recipient = normalizeVerifiedEmail(request.body.to);
            if (!recipient) return await reply.code(400).send({ error: "invalid_home_input" as const });
            const admitted = await inTx(async (tx) => {
                const authorization = await authorizeHomeGovernanceMutationInTx(tx, {
                    actorAccountId: request.userId,
                    request: { operation: "manage_home_settings" },
                });
                if (authorization.status === "rejected") return null;
                return { passwordUnreadable: isHomeSettingSecretUnreadable(await readHomeSettingsInTx(tx), PASSWORD_KEY) };
            });
            if (!admitted) return await reply.code(FORBIDDEN_STATUS).send({ error: "home_governance_forbidden" as const });
            if (admitted.passwordUnreadable) return await reply.send({ status: "failed" as const, reason: "password_unreadable" as const });
            // The recipient may be any address: it is the owner's own transport and the body is fixed
            // and carries no link or bearer (§3.3, binding).
            const result = await deps.authEmailDelivery.deliver({
                kind: "mail_delivery_test",
                to: recipient,
                homeName: resolveJoinScreenHomeDisplayName(await readRequestHomeEnv(request)),
            });
            if (result.status === "sent") return await reply.send({ status: "sent" as const });
            return await reply.send({ status: "failed" as const, reason: result.reason });
        },
    );

    app.post(
        homeDomainActionPathForMethod("home.audit.list", "POST"),
        {
            preHandler: [app.authenticate],
            attachValidation: true,
            schema: { body: HomeAuditListInputV1Schema, response: { 200: HomeAuditListResultV1Schema, ...ERROR_RESPONSES } },
            config: SETTINGS_RATE_LIMIT,
        },
        async (request, reply) => {
            if (request.validationError) return await reply.code(400).send({ error: "invalid_home_input" as const });
            const listing = await inTx(async (tx) => {
                const authorization = await authorizeHomeGovernanceMutationInTx(tx, {
                    actorAccountId: request.userId,
                    request: { operation: "view" },
                });
                if (authorization.status === "rejected") return null;
                return await listHomeAdministrationEventsInTx(tx, {
                    ...(request.body.cursor !== undefined ? { cursor: request.body.cursor } : {}),
                    ...(request.body.limit !== undefined ? { limit: request.body.limit } : {}),
                    ...(request.body.targetId !== undefined ? { targetId: request.body.targetId } : {}),
                });
            });
            if (!listing) return await reply.code(FORBIDDEN_STATUS).send({ error: "home_governance_forbidden" as const });
            if (listing.status === "invalid_cursor") {
                return await reply.code(homeGovernanceErrorHttpStatusV1("invalid_home_cursor")).send({ error: "invalid_home_cursor" as const });
            }
            return await reply.send(listing.result);
        },
    );
}
