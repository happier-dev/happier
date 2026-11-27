import {
    TEAM_BILLING_CHECKOUT_PATH, TEAM_SEATS_GET_ACTION_ID_V1, TeamBillingCheckoutV1Schema,
    TeamErrorV1Schema, TeamRefInputV1Schema, TeamSeatsV1Schema, teamErrorHttpStatusV1,
} from "@happier-dev/protocol/teams";
import { z } from "zod/mini";

import { ACCOUNT_DISPLAY_PROFILE_SELECT, projectAccountDisplayProfileV1 } from "@/app/account/profile/accountDisplayProfile";
import { homeDomainActionPathForMethod } from "@/app/api/routes/actions/homeDomainActionRoute";
import type { Fastify } from "@/app/api/types";
import { readPlansFeatureEnv } from "@/app/features/catalog/readFeatureEnv";
import { isServerFeatureEnabledForRequest, readHomeEffectiveEnv } from "@/app/features/catalog/serverFeatureGate";
import {
    qualifyTeamOperationAuthenticationInTx,
    readTeamOperationAuthenticationFromRequest,
    resolveTeamActorContextInTx,
    type TeamOperationAuthenticationContext,
} from "@/app/teams/actorContext";
import { hasActiveTeamPlan, readHostedTeamOffer } from "@/app/teams/memberships/teamGrowth";
import { createTeamRouteApp } from "@/app/teams/teamRouteApp";
import { inTx, type Tx } from "@/storage/inTx";
import { readTransactionDatabaseTime } from "@/storage/transactionDatabaseTime";

import { PolarRequestError, type PolarTeamClient } from "./polarClient";
import { countActiveTeamSeats } from "./teamSeats";

const TEAM_BILLING_FAILURES = {
    400: TeamErrorV1Schema,
    403: TeamErrorV1Schema,
    404: TeamErrorV1Schema,
    409: TeamErrorV1Schema,
    503: TeamErrorV1Schema,
} as const;

async function qualifyTeamBillingOwnerInTx(tx: Tx, input: Readonly<{
    teamId: string;
    actorAccountId: string;
    authentication: TeamOperationAuthenticationContext;
}>) {
    const context = await resolveTeamActorContextInTx(tx, input);
    if (!context?.teamCapabilities.viewTeam) return { ok: false, error: "team_not_found" } as const;
    if (!context.teamCapabilities.manageOwners) return { ok: false, error: "team_forbidden" } as const;
    return qualifyTeamOperationAuthenticationInTx(tx, { context, ...input.authentication });
}

async function readTeamBillingOfferInTx(tx: Tx, teamId: string, env: NodeJS.ProcessEnv) {
    const offer = readHostedTeamOffer(env);
    if (!offer) return null;
    const team = await tx.team.findUniqueOrThrow({
        where: { id: teamId }, select: { paidSeats: true, planEndsAt: true },
    });
    const active = hasActiveTeamPlan(team, await readTransactionDatabaseTime(tx));
    const maxMembers = readPlansFeatureEnv(env).teamsMaxMembers;
    const checkoutAvailable = !active && (maxMembers === null || maxMembers > offer.freeSeats);
    return { offer, paidSeats: active ? team.paidSeats : 0, checkoutAvailable };
}

export function registerTeamBillingRoutes(
    app: Fastify,
    input: Readonly<{ env?: NodeJS.ProcessEnv; polar: PolarTeamClient; canVerifyCheckout: boolean }>,
): void {
    const teams = createTeamRouteApp(app, { env: input.env });
    teams.post(homeDomainActionPathForMethod(TEAM_SEATS_GET_ACTION_ID_V1, "POST"), {
        preHandler: app.authenticate,
        attachValidation: true,
        schema: {
            body: TeamRefInputV1Schema,
            response: { 200: TeamSeatsV1Schema, ...TEAM_BILLING_FAILURES },
        },
    }, async (request, reply) => {
        if (request.validationError) return reply.code(400).send({ error: "invalid_team_input" });
        const env = await readHomeEffectiveEnv({ env: input.env, request });
        if (!isServerFeatureEnabledForRequest("plans", env)) return reply.code(503).send({ error: "teams_unavailable" });
        const { teamId } = request.body;
        const result = await inTx(async tx => {
            const qualified = await qualifyTeamBillingOwnerInTx(tx, {
                teamId, actorAccountId: request.userId, authentication: readTeamOperationAuthenticationFromRequest(request, env),
            });
            if (!qualified.ok) return qualified;
            const billing = await readTeamBillingOfferInTx(tx, teamId, env);
            if (!billing) return { ok: false, error: "teams_unavailable" } as const;
            const members = await tx.teamMembership.findMany({
                where: { teamId, status: "active" },
                orderBy: [{ createdAt: "asc" }, { id: "asc" }],
                select: { account: { select: ACCOUNT_DISPLAY_PROFILE_SELECT } },
            });
            const monthly = billing.offer.seatPrices.find(price => price.interval === "month");
            return { ok: true, seats: {
                freeSeats: billing.offer.freeSeats,
                paidSeats: billing.paidSeats,
                checkoutAvailable: input.canVerifyCheckout && billing.checkoutAvailable,
                monthlyPrice: monthly ? { amountMinor: monthly.amountMinor, currency: monthly.currency } : null,
                members: members.map(({ account }) => ({ accountId: account.id, profile: projectAccountDisplayProfileV1(account) })),
            } } as const;
        });
        if (!result.ok) return reply.code(teamErrorHttpStatusV1(result.error)).send({ error: result.error });
        return reply.send(result.seats);
    });
    teams.post(TEAM_BILLING_CHECKOUT_PATH, {
        preHandler: app.authenticate,
        schema: {
            params: z.pick(TeamRefInputV1Schema, { teamId: true }),
            response: {
                200: TeamBillingCheckoutV1Schema,
                ...TEAM_BILLING_FAILURES,
                409: z.union([TeamErrorV1Schema, z.strictObject({ error: z.literal("checkout_unavailable") })]),
                502: z.strictObject({ error: z.literal("provider_unavailable") }),
            },
        },
    }, async (request, reply) => {
        const env = await readHomeEffectiveEnv({ env: input.env, request });
        if (!isServerFeatureEnabledForRequest("plans", env)) return reply.code(503).send({ error: "teams_unavailable" });
        const { teamId } = request.params;
        const admission = await inTx(async tx => {
            const qualified = await qualifyTeamBillingOwnerInTx(tx, {
                teamId, actorAccountId: request.userId, authentication: readTeamOperationAuthenticationFromRequest(request, env),
            });
            if (!qualified.ok) return qualified;
            if (!input.canVerifyCheckout) return null;
            const billing = await readTeamBillingOfferInTx(tx, teamId, env);
            if (!billing?.checkoutAvailable) return null;
            const activeSeats = await countActiveTeamSeats(tx, teamId);
            return { productId: billing.offer.polarProductId, units: Math.max(billing.offer.freeSeats + 1, activeSeats + 1) };
        });
        if (!admission) return reply.code(409).send({ error: "checkout_unavailable" });
        if ("error" in admission) {
            const status = teamErrorHttpStatusV1(admission.error);
            return reply.code(status).send({ error: admission.error });
        }
        try {
            const checkout = await input.polar.createTeamCheckout({ ...admission, teamId, customerIp: request.ip });
            return reply.send(checkout);
        } catch (error) {
            if (error instanceof PolarRequestError) return reply.code(502).send({ error: "provider_unavailable" });
            throw error;
        }
    });
}
