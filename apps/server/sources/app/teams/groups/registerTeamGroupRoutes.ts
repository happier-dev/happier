import { z } from "zod/mini";

import { decodeMembershipSessionDataKeyEnvelopeCursorV1, MembershipSessionDataKeyEnvelopePageQueryV1Schema, MembershipSessionDataKeyEnvelopePageV1Schema, PatchMembershipSessionDataKeyEnvelopesResultV1Schema, PatchMembershipSessionDataKeyEnvelopesV1Schema } from '@happier-dev/protocol/sessions/encryption/membershipSessionDataKeyEnvelopes';
import {
    TeamErrorV1Schema,
    TeamGroupCreateInputV1Schema,
    TeamGroupLabelEnvelopeRepairsV1Schema,
    TeamGroupLabelEnvelopeWorkV1Schema,
    TeamGroupMemberAddInputV1Schema,
    TeamGroupMemberMutationResultV1Schema,
    TeamGroupMemberRemoveInputV1Schema,
    TeamGroupMembersListInputV1Schema,
    TeamGroupMembersPageV1Schema,
    TeamGroupRefInputV1Schema,
    TeamGroupUpdateInputV1Schema,
    TeamGroupV1Schema,
    TeamGroupsListInputV1Schema,
    TeamGroupsPageV1Schema,
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
import { readTeamOperationAuthenticationFromRequest } from "../actorContext";
import { createTeamRouteApp } from "../teamRouteApp";
import { readTeamGroupLabelEnvelopeWorkInTx, repairTeamGroupLabelEnvelopesInTx } from './labelEnvelopes';

import {
    addTeamGroupMemberForActorInTx,
    archiveTeamGroupForActorInTx,
    createTeamGroupForActorInTx,
    getTeamGroupForActorInTx,
    listTeamGroupMembersForActorInTx,
    listTeamGroupsForActorInTx,
    removeTeamGroupMemberForActorInTx,
    restoreTeamGroupForActorInTx,
    updateTeamGroupForActorInTx,
} from "./groupService";

/**
 * The flat-Group transports.
 *
 * Thin by construction: the Group owner decides metadata authority, roster
 * authority, archive semantics, and the contribution union, and none of those
 * decisions is repeated here. `teams.groups.members.*` writes only the native
 * contribution — a directory's contributions are reached through the
 * external-fact seam, never through a public route.
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

const GROUP_MEMBERSHIP_SESSION_DATA_KEY_ENVELOPES_PATH =
    "/v2/teams/:teamId/groups/:groupId/members/:accountId/sessions/data-key/envelopes";

const GroupMembershipEnvelopeParamsSchema = z.strictObject({
    teamId: z.string().check(z.minLength(1)),
    groupId: z.string().check(z.minLength(1)),
    accountId: z.string().check(z.minLength(1)),
});

export function registerTeamGroupRoutes(app: Fastify) {
    const teamsApp = createTeamRouteApp(app);

    function fail(reply: TeamErrorReply, error: TeamErrorCodeV1): void {
        reply.code(teamErrorHttpStatusV1(error)).send({ error });
    }

    teamsApp.get('/v2/teams/groups/label-envelopes', {
        preHandler: app.authenticate,
        schema: { response: { 200: TeamGroupLabelEnvelopeWorkV1Schema, ...TEAM_ERROR_RESPONSES } },
    }, async (request, reply) => reply.send(await inTx(tx => readTeamGroupLabelEnvelopeWorkInTx(tx,
        request.userId, readTeamOperationAuthenticationFromRequest(request)))));

    teamsApp.patch('/v2/teams/groups/label-envelopes', {
        preHandler: app.authenticate,
        attachValidation: true,
        schema: { body: TeamGroupLabelEnvelopeRepairsV1Schema,
            response: { 200: z.strictObject({ ok: z.literal(true) }), ...TEAM_ERROR_RESPONSES } },
    }, async (request, reply) => {
        if (request.validationError) return fail(reply, 'invalid_team_input');
        const result = await inTx(tx => repairTeamGroupLabelEnvelopesInTx(tx, request.userId, request.body,
            readTeamOperationAuthenticationFromRequest(request)), { isolationLevel: 'ReadCommitted' });
        if (result !== 'ready') return fail(reply, result);
        return reply.send({ ok: true });
    });

    teamsApp.post(homeDomainActionPathForMethod("teams.groups.list", "POST"), {
        preHandler: app.authenticate,
        attachValidation: true,
        schema: {
            body: TeamGroupsListInputV1Schema,
            response: { 200: TeamGroupsPageV1Schema, ...TEAM_ERROR_RESPONSES },
        },
    }, async (request, reply) => {
        // A malformed body is answered in the one shared Team error envelope. Without
        // this the framework's own validation body would be serialized against the
        // declared 400 schema, fail, and surface as a 500 for a plain client mistake.
        if (request.validationError) return fail(reply, "invalid_team_input");
        const result = await inTx(async (tx) => listTeamGroupsForActorInTx(tx, {
            teamId: request.body.teamId,
            actorAccountId: request.userId,
            authentication: readTeamOperationAuthenticationFromRequest(request),
            archived: request.body.archived,
            ...(request.body.cursor === undefined ? {} : { cursor: request.body.cursor }),
            ...(request.body.limit === undefined ? {} : { limit: request.body.limit }),
        }));
        if (!result.ok) return fail(reply, result.error);
        return reply.send(result.value);
    });

    teamsApp.post(homeDomainActionPathForMethod("teams.groups.get", "POST"), {
        preHandler: app.authenticate,
        attachValidation: true,
        schema: { body: TeamGroupRefInputV1Schema, response: { 200: TeamGroupV1Schema, ...TEAM_ERROR_RESPONSES } },
    }, async (request, reply) => {
        // A malformed body is answered in the one shared Team error envelope. Without
        // this the framework's own validation body would be serialized against the
        // declared 400 schema, fail, and surface as a 500 for a plain client mistake.
        if (request.validationError) return fail(reply, "invalid_team_input");
        const result = await inTx(async (tx) => getTeamGroupForActorInTx(tx, {
            teamId: request.body.teamId,
            actorAccountId: request.userId,
            authentication: readTeamOperationAuthenticationFromRequest(request),
            groupId: request.body.groupId,
        }));
        if (!result.ok) return fail(reply, result.error);
        return reply.send(result.value);
    });

    teamsApp.post(homeDomainActionPathForMethod("teams.groups.create", "POST"), {
        preHandler: app.authenticate,
        attachValidation: true,
        schema: { body: TeamGroupCreateInputV1Schema, response: { 200: TeamGroupV1Schema, ...TEAM_ERROR_RESPONSES } },
    }, async (request, reply) => {
        // A malformed body is answered in the one shared Team error envelope. Without
        // this the framework's own validation body would be serialized against the
        // declared 400 schema, fail, and surface as a 500 for a plain client mistake.
        if (request.validationError) return fail(reply, "invalid_team_input");
        const result = await inTx(async (tx) => createTeamGroupForActorInTx(tx, {
            teamId: request.body.teamId,
            actorAccountId: request.userId,
            authentication: readTeamOperationAuthenticationFromRequest(request),
            groupId: request.body.groupId,
            name: request.body.name,
            ...(request.body.description === undefined
                ? {}
                : { description: request.body.description }),
            requestKey: request.body.requestKey,
        }), { isolationLevel: "ReadCommitted" /* Complete Account admission and the Team guard precede fresh authority and replay reads. */ });
        if (!result.ok) return fail(reply, result.error);
        return reply.send(result.value);
    });

    teamsApp.post(homeDomainActionPathForMethod("teams.groups.update", "POST"), {
        preHandler: app.authenticate,
        attachValidation: true,
        schema: { body: TeamGroupUpdateInputV1Schema, response: { 200: TeamGroupV1Schema, ...TEAM_ERROR_RESPONSES } },
    }, async (request, reply) => {
        // A malformed body is answered in the one shared Team error envelope. Without
        // this the framework's own validation body would be serialized against the
        // declared 400 schema, fail, and surface as a 500 for a plain client mistake.
        if (request.validationError) return fail(reply, "invalid_team_input");
        const result = await inTx(async (tx) => updateTeamGroupForActorInTx(tx, {
            teamId: request.body.teamId,
            actorAccountId: request.userId,
            authentication: readTeamOperationAuthenticationFromRequest(request),
            groupId: request.body.groupId,
            ...(request.body.name === undefined ? {} : { name: request.body.name }),
            ...(request.body.description === undefined
                ? {}
                : { description: request.body.description }),
        }), { isolationLevel: "ReadCommitted" /* Existing Team admission precedes current authority and label-recipient admission. */ });
        if (!result.ok) return fail(reply, result.error);
        return reply.send(result.value);
    });

    teamsApp.post(homeDomainActionPathForMethod("teams.groups.archive", "POST"), {
        preHandler: app.authenticate,
        attachValidation: true,
        schema: { body: TeamGroupRefInputV1Schema, response: { 200: TeamGroupV1Schema, ...TEAM_ERROR_RESPONSES } },
    }, async (request, reply) => {
        // A malformed body is answered in the one shared Team error envelope. Without
        // this the framework's own validation body would be serialized against the
        // declared 400 schema, fail, and surface as a 500 for a plain client mistake.
        if (request.validationError) return fail(reply, "invalid_team_input");
        const result = await inTx(async (tx) => archiveTeamGroupForActorInTx(tx, {
            teamId: request.body.teamId,
            actorAccountId: request.userId,
            authentication: readTeamOperationAuthenticationFromRequest(request),
            groupId: request.body.groupId,
        }), { isolationLevel: "Serializable" /* Group archival participates in effective native/directory contribution and audience admission. */ });
        if (!result.ok) return fail(reply, result.error);
        return reply.send(result.value);
    });

    teamsApp.post(homeDomainActionPathForMethod("teams.groups.restore", "POST"), {
        preHandler: app.authenticate,
        attachValidation: true,
        schema: { body: TeamGroupRefInputV1Schema, response: { 200: TeamGroupV1Schema, ...TEAM_ERROR_RESPONSES } },
    }, async (request, reply) => {
        // A malformed body is answered in the one shared Team error envelope. Without
        // this the framework's own validation body would be serialized against the
        // declared 400 schema, fail, and surface as a 500 for a plain client mistake.
        if (request.validationError) return fail(reply, "invalid_team_input");
        const result = await inTx(async (tx) => restoreTeamGroupForActorInTx(tx, {
            teamId: request.body.teamId,
            actorAccountId: request.userId,
            authentication: readTeamOperationAuthenticationFromRequest(request),
            groupId: request.body.groupId,
        }), { isolationLevel: "Serializable" /* Group restoration participates in effective native/directory contribution and audience admission. */ });
        if (!result.ok) return fail(reply, result.error);
        return reply.send(result.value);
    });

    teamsApp.post(homeDomainActionPathForMethod("teams.groups.members.list", "POST"), {
        preHandler: app.authenticate,
        attachValidation: true,
        schema: {
            body: TeamGroupMembersListInputV1Schema,
            response: { 200: TeamGroupMembersPageV1Schema, ...TEAM_ERROR_RESPONSES },
        },
    }, async (request, reply) => {
        // A malformed body is answered in the one shared Team error envelope. Without
        // this the framework's own validation body would be serialized against the
        // declared 400 schema, fail, and surface as a 500 for a plain client mistake.
        if (request.validationError) return fail(reply, "invalid_team_input");
        const result = await inTx(async (tx) => listTeamGroupMembersForActorInTx(tx, {
            teamId: request.body.teamId,
            actorAccountId: request.userId,
            authentication: readTeamOperationAuthenticationFromRequest(request),
            groupId: request.body.groupId,
            ...(request.body.cursor === undefined ? {} : { cursor: request.body.cursor }),
            ...(request.body.limit === undefined ? {} : { limit: request.body.limit }),
        }));
        if (!result.ok) return fail(reply, result.error);
        return reply.send(result.value);
    });

    teamsApp.post(homeDomainActionPathForMethod("teams.groups.members.add", "POST"), {
        preHandler: app.authenticate,
        attachValidation: true,
        schema: {
            body: TeamGroupMemberAddInputV1Schema,
            response: { 200: TeamGroupMemberMutationResultV1Schema, ...TEAM_ERROR_RESPONSES },
        },
    }, async (request, reply) => {
        // A malformed body is answered in the one shared Team error envelope. Without
        // this the framework's own validation body would be serialized against the
        // declared 400 schema, fail, and surface as a 500 for a plain client mistake.
        if (request.validationError) return fail(reply, "invalid_team_input");
        const result = await inTx(async (tx) => addTeamGroupMemberForActorInTx(tx, {
            teamId: request.body.teamId,
            actorAccountId: request.userId,
            authentication: readTeamOperationAuthenticationFromRequest(request),
            groupId: request.body.groupId,
            accountId: request.body.accountId,
            historyAccess: request.body.historyAccess,
        }), { isolationLevel: "ReadCommitted" /* The outer Team guard precedes the native/external union and prevents lost native admission during withdrawal. */ });
        if (!result.ok) return fail(reply, result.error);
        return reply.send(result.value);
    });

    teamsApp.post(homeDomainActionPathForMethod("teams.groups.members.remove", "POST"), {
        preHandler: app.authenticate,
        attachValidation: true,
        schema: {
            body: TeamGroupMemberRemoveInputV1Schema,
            response: { 200: TeamGroupMemberMutationResultV1Schema, ...TEAM_ERROR_RESPONSES },
        },
    }, async (request, reply) => {
        // A malformed body is answered in the one shared Team error envelope. Without
        // this the framework's own validation body would be serialized against the
        // declared 400 schema, fail, and surface as a 500 for a plain client mistake.
        if (request.validationError) return fail(reply, "invalid_team_input");
        const result = await inTx(async (tx) => removeTeamGroupMemberForActorInTx(tx, {
            teamId: request.body.teamId,
            actorAccountId: request.userId,
            authentication: readTeamOperationAuthenticationFromRequest(request),
            groupId: request.body.groupId,
            accountId: request.body.accountId,
        }), { isolationLevel: "ReadCommitted" /* Complete Account admission and the outer Team guard precede the fresh contribution union. */ });
        if (!result.ok) return fail(reply, result.error);
        return reply.send(result.value);
    });

    /**
     * Membership-history Session-key preparation, in the Group membership context.
     *
     * Lane 01 keys a Group membership by the current Team-membership lifetime, so
     * the public address is `{ teamId, groupId, accountId }` and resolves inside
     * the same transaction. This route invents no Group-membership surrogate and
     * shares the one membership envelope service with the Team address.
     */
    teamsApp.get(GROUP_MEMBERSHIP_SESSION_DATA_KEY_ENVELOPES_PATH, {
        preHandler: app.authenticate,
        attachValidation: true,
        schema: {
            params: GroupMembershipEnvelopeParamsSchema,
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
                kind: "group",
                teamId: request.params.teamId,
                groupId: request.params.groupId,
                accountId: request.params.accountId,
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

    teamsApp.patch(GROUP_MEMBERSHIP_SESSION_DATA_KEY_ENVELOPES_PATH, {
        preHandler: app.authenticate,
        attachValidation: true,
        schema: {
            params: GroupMembershipEnvelopeParamsSchema,
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
                kind: "group",
                teamId: request.params.teamId,
                groupId: request.params.groupId,
                accountId: request.params.accountId,
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
