import { z } from "zod";

import {
    decodeMembershipSessionDataKeyEnvelopeCursorV1,
    MembershipSessionDataKeyEnvelopePageQueryV1Schema,
    MembershipSessionDataKeyEnvelopePageV1Schema,
    PatchMembershipSessionDataKeyEnvelopesResultV1Schema,
    PatchMembershipSessionDataKeyEnvelopesV1Schema,
} from "@happier-dev/protocol";
import {
    TeamErrorV1Schema,
    TeamMemberAddInputV1Schema,
    TeamMemberGroupsListInputV1Schema,
    TeamMemberManagementSetInputV1Schema,
    TeamMemberRefInputV1Schema,
    TeamMemberRemoveResultV1Schema,
    TeamMemberRoleSetInputV1Schema,
    TeamMembersListInputV1Schema,
    TeamMembersPageV1Schema,
    TeamGroupsPageV1Schema,
    TeamMembershipV1Schema,
    TeamRefInputV1Schema,
    teamErrorHttpStatusV1,
    type TeamErrorCodeV1,
} from "@happier-dev/protocol/teams";

import type { Fastify } from "@/app/api/types";
import { homeDomainActionPathForMethod } from "@/app/api/routes/actions/homeDomainActionRoute";
import {
    applyMembershipSessionDataKeyEnvelopes,
    membershipSessionDataKeyEnvelopeHttpStatus,
    readMembershipSessionDataKeyEnvelopePage,
    MEMBERSHIP_SESSION_DATA_KEY_ENVELOPE_ERROR_RESPONSES,
} from "@/app/session/encryption/membershipSessionDataKeyEnvelopeService";
import { inTx } from "@/storage/inTx";
import { readSessionAccessAuthenticationFromRequest } from "@/app/session/access/sessionAccessAuthentication";

import {
    addTeamMemberForActorInTx,
    getTeamMemberForActorInTx,
    listTeamMembersForActorInTx,
    reactivateTeamMemberForActorInTx,
    removeTeamMemberForActorInTx,
    setTeamMemberManagementForActorInTx,
    setTeamMemberRoleForActorInTx,
    suspendTeamMemberForActorInTx,
} from "./memberAdministration";
import { listTeamMemberGroupsForActorInTx } from "../groups/groupService";
import { readTeamOperationAuthenticationFromRequest } from "../actorContext";
import { createTeamRouteApp } from "../teamRouteApp";

/**
 * The Team membership transports.
 *
 * They authenticate, parse the strict protocol input, call one canonical
 * service, and map its typed result to HTTP. There is no role comparison, no
 * last-owner rule, no management-source branch, and no history decision here —
 * every one of those belongs to the membership owner, and duplicating any of
 * them at the transport would create a second authority for it.
 */

/**
 * The reply capability every failure path needs: set one of the four declared
 * Team error statuses and send the one shared error envelope. Naming it keeps
 * the helper independent of Fastify's overload shapes, and it only type-checks
 * for a route that actually declares all four — which is the point, since a
 * route may not answer with a status its schema does not publish.
 */
type TeamErrorReply = Readonly<{
    code: (status: 400 | 403 | 404 | 409 | 503) => {
        send: (payload: Readonly<{ error: TeamErrorCodeV1 }>) => void;
    };
}>;

/**
 * The four error statuses every Team route publishes. They are spread into each
 * route's response map rather than passed as one object: a shared object breaks
 * the Zod type provider's inference, which silently degrades `request.body` to
 * `unknown` and takes the strict input contract with it.
 */
const TEAM_ERROR_RESPONSES = {
    400: TeamErrorV1Schema,
    403: TeamErrorV1Schema,
    404: TeamErrorV1Schema,
    409: TeamErrorV1Schema,
    503: TeamErrorV1Schema,
} as const;

/**
 * The nested membership-history envelope address. `data-key` stays singular
 * under `sessions` even though one page spans many Sessions: the resource is
 * "this membership's Session data-key preparation", not a Team key store.
 */
const MEMBERSHIP_SESSION_DATA_KEY_ENVELOPES_PATH =
    "/v2/teams/:teamId/members/:teamMembershipId/sessions/data-key/envelopes";

const MembershipEnvelopeParamsSchema = z.object({
    teamId: z.string().min(1),
    teamMembershipId: z.string().min(1),
}).strict();

export function registerTeamMemberRoutes(app: Fastify) {
    const teamsApp = createTeamRouteApp(app);

    function fail(reply: TeamErrorReply, error: TeamErrorCodeV1): void {
        reply.code(teamErrorHttpStatusV1(error)).send({ error });
    }

    teamsApp.post(homeDomainActionPathForMethod("teams.members.list", "POST"), {
        preHandler: app.authenticate,
        attachValidation: true,
                schema: {
            body: TeamMembersListInputV1Schema,
            response: { 200: TeamMembersPageV1Schema, ...TEAM_ERROR_RESPONSES },
        },
    }, async (request, reply) => {
        // A malformed body is answered in the one shared Team error envelope. Without
        // this the framework's own validation body would be serialized against the
        // declared 400 schema, fail, and surface as a 500 for a plain client mistake.
        if (request.validationError) return fail(reply, "invalid_team_input");
        const result = await inTx(async (tx) => listTeamMembersForActorInTx(tx, {
            teamId: request.body.teamId,
            actorAccountId: request.userId,
            authentication: readTeamOperationAuthenticationFromRequest(request),
            filter: request.body.filter,
            ...(request.body.query === undefined ? {} : { query: request.body.query }),
            ...(request.body.cursor === undefined ? {} : { cursor: request.body.cursor }),
            ...(request.body.limit === undefined ? {} : { limit: request.body.limit }),
        }));
        if (!result.ok) return fail(reply, result.error);
        return reply.send(result.value);
    });

    teamsApp.post(homeDomainActionPathForMethod("teams.members.get", "POST"), {
        preHandler: app.authenticate,
        attachValidation: true,
        schema: { body: TeamMemberRefInputV1Schema, response: { 200: TeamMembershipV1Schema, ...TEAM_ERROR_RESPONSES } },
    }, async (request, reply) => {
        // A malformed body is answered in the one shared Team error envelope. Without
        // this the framework's own validation body would be serialized against the
        // declared 400 schema, fail, and surface as a 500 for a plain client mistake.
        if (request.validationError) return fail(reply, "invalid_team_input");
        const result = await inTx(async (tx) => getTeamMemberForActorInTx(tx, {
            teamId: request.body.teamId,
            actorAccountId: request.userId,
            authentication: readTeamOperationAuthenticationFromRequest(request),
            membershipId: request.body.membershipId,
        }));
        if (!result.ok) return fail(reply, result.error);
        return reply.send(result.value);
    });

    teamsApp.post(homeDomainActionPathForMethod("teams.members.groups.list", "POST"), {
        preHandler: app.authenticate,
        attachValidation: true,
        schema: {
            body: TeamMemberGroupsListInputV1Schema,
            response: { 200: TeamGroupsPageV1Schema, ...TEAM_ERROR_RESPONSES },
        },
    }, async (request, reply) => {
        if (request.validationError) return fail(reply, "invalid_team_input");
        const result = await inTx((tx) => listTeamMemberGroupsForActorInTx(tx, {
            teamId: request.body.teamId,
            actorAccountId: request.userId,
            authentication: readTeamOperationAuthenticationFromRequest(request),
            membershipId: request.body.membershipId,
            ...(request.body.cursor === undefined ? {} : { cursor: request.body.cursor }),
            ...(request.body.limit === undefined ? {} : { limit: request.body.limit }),
        }));
        if (!result.ok) return fail(reply, result.error);
        return reply.send(result.value);
    });

    teamsApp.post(homeDomainActionPathForMethod("teams.members.add", "POST"), {
        preHandler: app.authenticate,
        attachValidation: true,
        schema: {
            body: TeamMemberAddInputV1Schema,
            response: { 200: TeamMembershipV1Schema, ...TEAM_ERROR_RESPONSES },
        },
    }, async (request, reply) => {
        // A malformed body is answered in the one shared Team error envelope. Without
        // this the framework's own validation body would be serialized against the
        // declared 400 schema, fail, and surface as a 500 for a plain client mistake.
        if (request.validationError) return fail(reply, "invalid_team_input");
        const result = await inTx(async (tx) => addTeamMemberForActorInTx(tx, {
            teamId: request.body.teamId,
            actorAccountId: request.userId,
            authentication: readTeamOperationAuthenticationFromRequest(request),
            accountId: request.body.accountId,
            role: request.body.role,
            historyAccess: request.body.historyAccess,
        }));
        if (!result.ok) return fail(reply, result.error);
        return reply.send(result.value);
    });

    teamsApp.post(homeDomainActionPathForMethod("teams.members.role.set", "POST"), {
        preHandler: app.authenticate,
        attachValidation: true,
        schema: { body: TeamMemberRoleSetInputV1Schema, response: { 200: TeamMembershipV1Schema, ...TEAM_ERROR_RESPONSES } },
    }, async (request, reply) => {
        // A malformed body is answered in the one shared Team error envelope. Without
        // this the framework's own validation body would be serialized against the
        // declared 400 schema, fail, and surface as a 500 for a plain client mistake.
        if (request.validationError) return fail(reply, "invalid_team_input");
        const result = await inTx(async (tx) => setTeamMemberRoleForActorInTx(tx, {
            teamId: request.body.teamId,
            actorAccountId: request.userId,
            authentication: readTeamOperationAuthenticationFromRequest(request),
            membershipId: request.body.membershipId,
            role: request.body.role,
        }));
        if (!result.ok) return fail(reply, result.error);
        return reply.send(result.value);
    });

    teamsApp.post(homeDomainActionPathForMethod("teams.members.suspend", "POST"), {
        preHandler: app.authenticate,
        attachValidation: true,
        schema: { body: TeamMemberRefInputV1Schema, response: { 200: TeamMembershipV1Schema, ...TEAM_ERROR_RESPONSES } },
    }, async (request, reply) => {
        // A malformed body is answered in the one shared Team error envelope. Without
        // this the framework's own validation body would be serialized against the
        // declared 400 schema, fail, and surface as a 500 for a plain client mistake.
        if (request.validationError) return fail(reply, "invalid_team_input");
        const result = await inTx(async (tx) => suspendTeamMemberForActorInTx(tx, {
            teamId: request.body.teamId,
            actorAccountId: request.userId,
            authentication: readTeamOperationAuthenticationFromRequest(request),
            membershipId: request.body.membershipId,
        }));
        if (!result.ok) return fail(reply, result.error);
        return reply.send(result.value);
    });

    teamsApp.post(homeDomainActionPathForMethod("teams.members.reactivate", "POST"), {
        preHandler: app.authenticate,
        attachValidation: true,
        schema: { body: TeamMemberRefInputV1Schema, response: { 200: TeamMembershipV1Schema, ...TEAM_ERROR_RESPONSES } },
    }, async (request, reply) => {
        // A malformed body is answered in the one shared Team error envelope. Without
        // this the framework's own validation body would be serialized against the
        // declared 400 schema, fail, and surface as a 500 for a plain client mistake.
        if (request.validationError) return fail(reply, "invalid_team_input");
        const result = await inTx(async (tx) => reactivateTeamMemberForActorInTx(tx, {
            teamId: request.body.teamId,
            actorAccountId: request.userId,
            authentication: readTeamOperationAuthenticationFromRequest(request),
            membershipId: request.body.membershipId,
        }));
        if (!result.ok) return fail(reply, result.error);
        return reply.send(result.value);
    });

    teamsApp.post(homeDomainActionPathForMethod("teams.members.remove", "POST"), {
        preHandler: app.authenticate,
        attachValidation: true,
        schema: {
            body: TeamMemberRefInputV1Schema,
            response: { 200: TeamMemberRemoveResultV1Schema, ...TEAM_ERROR_RESPONSES },
        },
    }, async (request, reply) => {
        // A malformed body is answered in the one shared Team error envelope. Without
        // this the framework's own validation body would be serialized against the
        // declared 400 schema, fail, and surface as a 500 for a plain client mistake.
        if (request.validationError) return fail(reply, "invalid_team_input");
        const result = await inTx(async (tx) => removeTeamMemberForActorInTx(tx, {
            teamId: request.body.teamId,
            actorAccountId: request.userId,
            authentication: readTeamOperationAuthenticationFromRequest(request),
            membershipId: request.body.membershipId,
        }));
        if (!result.ok) return fail(reply, result.error);
        return reply.send(result.value);
    });

    teamsApp.post(homeDomainActionPathForMethod("teams.members.leave", "POST"), {
        preHandler: app.authenticate,
        attachValidation: true,
        schema: { body: TeamRefInputV1Schema, response: { 200: TeamMemberRemoveResultV1Schema, ...TEAM_ERROR_RESPONSES } },
    }, async (request, reply) => {
        if (request.validationError) return fail(reply, "invalid_team_input");
        const result = await inTx((tx) => removeTeamMemberForActorInTx(tx, {
            teamId: request.body.teamId,
            actorAccountId: request.userId,
            authentication: readTeamOperationAuthenticationFromRequest(request),
        }));
        if (!result.ok) return fail(reply, result.error);
        return reply.send(result.value);
    });

    teamsApp.post(homeDomainActionPathForMethod("teams.members.management.set", "POST"), {
        preHandler: app.authenticate,
        attachValidation: true,
        schema: { body: TeamMemberManagementSetInputV1Schema, response: { 200: TeamMembershipV1Schema, ...TEAM_ERROR_RESPONSES } },
    }, async (request, reply) => {
        // A malformed body is answered in the one shared Team error envelope. Without
        // this the framework's own validation body would be serialized against the
        // declared 400 schema, fail, and surface as a 500 for a plain client mistake.
        if (request.validationError) return fail(reply, "invalid_team_input");
        const result = await inTx(async (tx) => setTeamMemberManagementForActorInTx(tx, {
            teamId: request.body.teamId,
            actorAccountId: request.userId,
            authentication: readTeamOperationAuthenticationFromRequest(request),
            membershipId: request.body.membershipId,
            management: request.body.management,
        }));
        if (!result.ok) return fail(reply, result.error);
        return reply.send(result.value);
    });

    /**
     * Membership-history Session-key preparation, in the Team membership context.
     *
     * The transport is a context adapter: it names the subject and hands it to
     * the one membership envelope service, which composes the Team read owner,
     * Lane 04's eligible-Session predicate, the Account readiness owner and the
     * Protocol codec. No history, access or crypto decision is repeated here.
     */
    teamsApp.get(MEMBERSHIP_SESSION_DATA_KEY_ENVELOPES_PATH, {
        preHandler: app.authenticate,
        attachValidation: true,
        schema: {
            params: MembershipEnvelopeParamsSchema,
            querystring: MembershipSessionDataKeyEnvelopePageQueryV1Schema,
            response: {
                200: MembershipSessionDataKeyEnvelopePageV1Schema,
                ...MEMBERSHIP_SESSION_DATA_KEY_ENVELOPE_ERROR_RESPONSES,
            },
        },
    }, async (request, reply) => {
        if (request.validationError) {
            return reply.code(400).send({
                error: typeof request.query.cursor === "string"
                    && decodeMembershipSessionDataKeyEnvelopeCursorV1(request.query.cursor) === null
                    ? "invalid_cursor"
                    : "invalid_request",
            });
        }
        const result = await readMembershipSessionDataKeyEnvelopePage({
            actorAccountId: request.userId,
            authentication: readSessionAccessAuthenticationFromRequest(request),
            subject: {
                kind: "team",
                teamId: request.params.teamId,
                teamMembershipId: request.params.teamMembershipId,
            },
            query: request.query,
        });
        if (!result.ok) {
            return reply
                .code(membershipSessionDataKeyEnvelopeHttpStatus(result.error))
                .send({ error: result.error });
        }
        return reply.send(result.page);
    });

    teamsApp.patch(MEMBERSHIP_SESSION_DATA_KEY_ENVELOPES_PATH, {
        preHandler: app.authenticate,
        attachValidation: true,
        schema: {
            params: MembershipEnvelopeParamsSchema,
            body: PatchMembershipSessionDataKeyEnvelopesV1Schema,
            response: {
                200: PatchMembershipSessionDataKeyEnvelopesResultV1Schema,
                ...MEMBERSHIP_SESSION_DATA_KEY_ENVELOPE_ERROR_RESPONSES,
            },
        },
    }, async (request, reply) => {
        // A malformed body is answered in this resource's own error envelope;
        // the framework's validation body would fail the declared 400 schema
        // and surface a plain client mistake as a 500.
        if (request.validationError) return reply.code(400).send({ error: "invalid_request" });
        const result = await applyMembershipSessionDataKeyEnvelopes({
            actorAccountId: request.userId,
            authentication: readSessionAccessAuthenticationFromRequest(request),
            subject: {
                kind: "team",
                teamId: request.params.teamId,
                teamMembershipId: request.params.teamMembershipId,
            },
            request: request.body,
        });
        if (!result.ok) {
            return reply
                .code(membershipSessionDataKeyEnvelopeHttpStatus(result.error))
                .send({ error: result.error });
        }
        return reply.send({ appliedCount: result.appliedCount });
    });
}
