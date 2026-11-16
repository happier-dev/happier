import { TEAM_LOGO_REQUEST_MAX_BODY_BYTES_V1, TeamLogoSetInputV1Schema } from '@happier-dev/protocol/teams/logo';
import { TeamCreateInputV1Schema, TeamErrorV1Schema, TeamPolicySetInputV1Schema, TeamRefInputV1Schema, TeamUpdateInputV1Schema, teamErrorHttpStatusV1, type TeamErrorCodeV1, type TeamErrorV1 } from '@happier-dev/protocol/teams';
import { TeamSummaryV1Schema, TeamsListInputV1Schema, TeamsPageV1Schema } from '@happier-dev/protocol/teams/projections';

import type { Fastify } from "@/app/api/types";
import { homeDomainActionPathForMethod } from "@/app/api/routes/actions/homeDomainActionRoute";
import { resolveApiHotEndpointRateLimit } from "@/app/api/utils/apiRateLimitCatalog";
import { inTx } from "@/storage/inTx";

import {
    archiveTeamInTx,
    createTeamInTx,
    readTeamSummaryForActorInTx,
    restoreTeamInTx,
    updateTeamInTx,
} from "./lifecycle";
import { removeTeamLogo, setTeamLogo } from "./logo";
import { setTeamPolicyInTx } from "./policy";
import { listTeamsForActorInTx } from "./queries";
import {
    registerTeamIdentityRoutes,
    type TeamIdentityRouteDependencies,
} from "./identity/registerTeamIdentityRoutes";
import { registerTeamCredentialResourceRoutes } from "./credentials/registerTeamCredentialResourceRoutes";
import { readTeamOperationAuthenticationFromRequest } from "./actorContext";
import { createTeamRouteApp } from "./teamRouteApp";

/**
 * The Team lifecycle transports.
 *
 * They authenticate, parse the strict protocol input, call one canonical
 * service, and map its typed result to HTTP. No role comparison, archive rule,
 * membership transition, or downstream resource decision lives here.
 *
 * Every path is POST and is declared on its Action row by the shared Actions
 * catalog owner; this module owns the domain route itself, including the feature
 * gate, validation, authorization, and the transaction.
 */

/**
 * The reply capability every failure path needs: set one of the four declared
 * Team error statuses and send the one shared error envelope. Naming it keeps
 * the helper independent of Fastify's overload shapes, and `send` returns `void`
 * because that is what the route handler's own contract returns — a helper typed
 * to return a value would make every `return sendTeamError(...)` a handler-return
 * mismatch.
 */
type TeamErrorReply = Readonly<{
    code: (status: 400 | 403 | 404 | 409 | 503) => {
        send: (payload: TeamErrorV1) => void;
    };
}>;

/**
 * The four error statuses every Team route publishes. They are spread into each
 * route's response map rather than passed as one shared object: a shared object
 * breaks the Zod type provider's inference, which silently degrades
 * `request.body` to `unknown` and takes the strict input contract with it.
 */
const TEAM_ERROR_RESPONSES = {
    400: TeamErrorV1Schema,
    403: TeamErrorV1Schema,
    404: TeamErrorV1Schema,
    409: TeamErrorV1Schema,
    503: TeamErrorV1Schema,
} as const;

/**
 * The single domain-result → HTTP mapping, so one Team result cannot become two
 * wire contracts.
 */
function sendTeamError(reply: TeamErrorReply, error: TeamErrorCodeV1, details?: TeamErrorV1["details"]): void {
    reply.code(teamErrorHttpStatusV1(error)).send(details === undefined ? { error } : { error, details });
}

export function registerTeamRoutes(
    app: Fastify,
    env: NodeJS.ProcessEnv = process.env,
    dependencies: TeamIdentityRouteDependencies = {},
) {
    const teamsApp = createTeamRouteApp(app, { env });
    registerTeamIdentityRoutes(teamsApp, dependencies);
    // Credential resources publish their own strict error vocabulary and own
    // feature gate. Register them on the base app so the Team-domain denial
    // projection cannot overwrite that distinct transport contract.
    registerTeamCredentialResourceRoutes(app, env);

    teamsApp.post(homeDomainActionPathForMethod("teams.list", "POST"), {
        preHandler: app.authenticate,
        attachValidation: true,
        schema: {
            body: TeamsListInputV1Schema,
            response: { 200: TeamsPageV1Schema, ...TEAM_ERROR_RESPONSES },
        },
    }, async (request, reply) => {
        if (request.validationError) return sendTeamError(reply, "invalid_team_input");

        const result = await inTx(async (tx) => listTeamsForActorInTx(tx, {
            actorAccountId: request.userId,
            ...request.body,
            authentication: readTeamOperationAuthenticationFromRequest(request, env),
        }));
        if (!result.ok) return sendTeamError(reply, result.error);
        return reply.send(result.page);
    });

    teamsApp.post(homeDomainActionPathForMethod("teams.get", "POST"), {
        preHandler: app.authenticate,
        attachValidation: true,
        schema: { body: TeamRefInputV1Schema, response: { 200: TeamSummaryV1Schema, ...TEAM_ERROR_RESPONSES } },
    }, async (request, reply) => {
        if (request.validationError) return sendTeamError(reply, "invalid_team_input");

        const result = await inTx(async (tx) => readTeamSummaryForActorInTx(tx, {
            teamId: request.body.teamId,
            actorAccountId: request.userId,
            authentication: readTeamOperationAuthenticationFromRequest(request, env),
        }));
        // An unreadable Team and an absent one are the same answer, so Team
        // existence cannot be probed.
        if (!result.ok) return sendTeamError(reply, result.error);
        return reply.send(result.team);
    });

    teamsApp.post(homeDomainActionPathForMethod("teams.create", "POST"), {
        preHandler: app.authenticate,
        config: { rateLimit: resolveApiHotEndpointRateLimit(env, "account.settings") },
        attachValidation: true,
        schema: { body: TeamCreateInputV1Schema, response: { 200: TeamSummaryV1Schema, ...TEAM_ERROR_RESPONSES } },
    }, async (request, reply) => {
        if (request.validationError) return sendTeamError(reply, "invalid_team_input");

        const result = await inTx(async (tx) => createTeamInTx(tx, {
            actorAccountId: request.userId,
            name: request.body.name,
            description: request.body.description,
            ...(request.body.initialOwnerAccountId === undefined
                ? {}
                : { initialOwnerAccountId: request.body.initialOwnerAccountId }),
            requestKey: request.body.requestKey,
            env,
            authentication: readTeamOperationAuthenticationFromRequest(request, env),
        }), { isolationLevel: "ReadCommitted" /* Exclusive ordered creation audience precedes Home policy, owner eligibility and dedupe reads. */ });
        if (!result.ok) return sendTeamError(reply, result.error, result.details);
        return reply.send(result.team);
    });

    teamsApp.post(homeDomainActionPathForMethod("teams.update", "POST"), {
        preHandler: app.authenticate,
        attachValidation: true,
        schema: { body: TeamUpdateInputV1Schema, response: { 200: TeamSummaryV1Schema, ...TEAM_ERROR_RESPONSES } },
    }, async (request, reply) => {
        if (request.validationError) return sendTeamError(reply, "invalid_team_input");

        const result = await inTx(async (tx) => updateTeamInTx(tx, {
            actorAccountId: request.userId,
            teamId: request.body.teamId,
            ...(request.body.name === undefined ? {} : { name: request.body.name }),
            ...(request.body.description === undefined ? {} : { description: request.body.description }),
            env,
            authentication: readTeamOperationAuthenticationFromRequest(request, env),
        }), { isolationLevel: "ReadCommitted" /* Ordered Account admission and the Team lock precede fresh authority reads and the audience recheck. */ });
        if (!result.ok) return sendTeamError(reply, result.error);
        return reply.send(result.team);
    });

    teamsApp.post(homeDomainActionPathForMethod("teams.policy.set", "POST"), {
        preHandler: app.authenticate,
        config: { allowApiToken: true },
        attachValidation: true,
        schema: { body: TeamPolicySetInputV1Schema, response: { 200: TeamSummaryV1Schema, ...TEAM_ERROR_RESPONSES } },
    }, async (request, reply) => {
        if (request.validationError) return sendTeamError(reply, "invalid_team_input");

        const result = await inTx(async (tx) => setTeamPolicyInTx(tx, {
            actorAccountId: request.userId,
            env,
            authentication: readTeamOperationAuthenticationFromRequest(request, env),
            ...request.body,
        }), { isolationLevel: "ReadCommitted" /* Team lock and admitted Account cohort cover current policy, provider viability and actor authority. */ });
        if (!result.ok) return sendTeamError(reply, result.error, result.details);
        return reply.send(result.team);
    });

    teamsApp.post(homeDomainActionPathForMethod("teams.archive", "POST"), {
        preHandler: app.authenticate,
        attachValidation: true,
        schema: { body: TeamRefInputV1Schema, response: { 200: TeamSummaryV1Schema, ...TEAM_ERROR_RESPONSES } },
    }, async (request, reply) => {
        if (request.validationError) return sendTeamError(reply, "invalid_team_input");

        const result = await inTx(async (tx) => archiveTeamInTx(tx, {
            actorAccountId: request.userId,
            teamId: request.body.teamId,
            env,
            authentication: readTeamOperationAuthenticationFromRequest(request, env),
        }), { transactionClass: "teams.archive", isolationLevel: "ReadCommitted" /* Exclusive complete Account admission and the Team lock precede authority/access reads; audience rechecks cover discovery races. */ });
        if (!result.ok) return sendTeamError(reply, result.error);
        return reply.send(result.team);
    });

    teamsApp.post(homeDomainActionPathForMethod("teams.restore", "POST"), {
        preHandler: app.authenticate,
        attachValidation: true,
        schema: { body: TeamRefInputV1Schema, response: { 200: TeamSummaryV1Schema, ...TEAM_ERROR_RESPONSES } },
    }, async (request, reply) => {
        if (request.validationError) return sendTeamError(reply, "invalid_team_input");

        const result = await inTx(async (tx) => restoreTeamInTx(tx, {
            actorAccountId: request.userId,
            teamId: request.body.teamId,
            env,
            authentication: readTeamOperationAuthenticationFromRequest(request, env),
        }), { transactionClass: "teams.restore", isolationLevel: "ReadCommitted" /* Restore uses the same exclusive Account admission, Team lock and audience rechecks as archive. */ });
        if (!result.ok) return sendTeamError(reply, result.error);
        return reply.send(result.team);
    });

    teamsApp.post(homeDomainActionPathForMethod("teams.logo.set", "POST"), {
        preHandler: app.authenticate,
        config: { rateLimit: resolveApiHotEndpointRateLimit(env, "account.profile") },
        attachValidation: true,
        // Narrows the shared transport ceiling to what one maximal logo payload
        // needs, so an oversized upload is refused before it is buffered.
        bodyLimit: TEAM_LOGO_REQUEST_MAX_BODY_BYTES_V1,
        schema: { body: TeamLogoSetInputV1Schema, response: { 200: TeamSummaryV1Schema, ...TEAM_ERROR_RESPONSES } },
    }, async (request, reply) => {
        if (request.validationError) return sendTeamError(reply, "invalid_team_input");

        const result = await setTeamLogo({
            actorAccountId: request.userId,
            teamId: request.body.teamId,
            image: request.body.image,
            env,
            authentication: readTeamOperationAuthenticationFromRequest(request, env),
        });
        if (!result.ok) return sendTeamError(reply, result.error);
        return reply.send(result.team);
    });

    teamsApp.post(homeDomainActionPathForMethod("teams.logo.remove", "POST"), {
        preHandler: app.authenticate,
        attachValidation: true,
        schema: { body: TeamRefInputV1Schema, response: { 200: TeamSummaryV1Schema, ...TEAM_ERROR_RESPONSES } },
    }, async (request, reply) => {
        if (request.validationError) return sendTeamError(reply, "invalid_team_input");

        const result = await removeTeamLogo({
            actorAccountId: request.userId,
            teamId: request.body.teamId,
            env,
            authentication: readTeamOperationAuthenticationFromRequest(request, env),
        });
        if (!result.ok) return sendTeamError(reply, result.error);
        return reply.send(result.team);
    });
}
