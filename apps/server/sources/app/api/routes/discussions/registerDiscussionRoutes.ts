import { DISCUSSION_HTTP_PATHS_V1, DISCUSSION_NOT_TRACKED_CODE_V1, DiscussionCreateRequestV1Schema, DiscussionCreateResponseV1Schema, DiscussionDetailsResponseV1Schema, DiscussionErrorResponseV1Schema, DiscussionListQueryV1Schema, DiscussionListResponseV1Schema, DiscussionMessagesQueryV1Schema, DiscussionMessagesResponseV1Schema, DiscussionPostRequestV1Schema, DiscussionPostResponseV1Schema, DiscussionReadRequestV1Schema, DiscussionReadResponseV1Schema, DiscussionRenameRequestV1Schema, DiscussionRouteDiscussionParamsV1Schema, isDiscussionRequestWithinTransportBudgetV1 } from '@happier-dev/protocol/discussions/api';

import { createServerFeatureGatedRouteApp } from "@/app/features/catalog/serverFeatureGate";
import { resolveApiHotEndpointRateLimit } from "@/app/api/utils/apiRateLimitCatalog";
import {
    PresentUserRequiredResponseSchema,
} from "@/app/api/utils/requirePresentUser";
import { requireRouteActionAuthority } from "@/app/api/utils/requireRouteActionAuthority";
import {
    archiveDiscussion,
    createDiscussion,
    postDiscussionMessage,
    renameDiscussion,
    restoreDiscussion,
} from "@/app/discussions/mutations";
import {
    getDiscussion,
    listDiscussions,
    readDiscussionMessages,
} from "@/app/discussions/queries";
import { setDiscussionReadCursor } from "@/app/discussions/readState";
import type { DiscussionFailureCode } from "@/app/discussions/serviceTypes";
import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod/mini";
import { type Fastify } from "../../types";
import { readSessionAccessAuthenticationFromRequest } from "@/app/session/access/sessionAccessAuthentication";
import { DiscussionAccessGrantsListResponseV1Schema, DiscussionAccessGrantSetRequestV1Schema, DiscussionAccessGrantRemoveRequestV1Schema, DiscussionAccessGrantMutationResponseV1Schema, DiscussionLeaveResponseV1Schema, DiscussionAccessRecipientCensusResponseV1Schema, DiscussionRecipientKeyEnvelopeCommitInputV1Schema, DiscussionRecipientKeyEnvelopeCommitResponseV1Schema } from "@happier-dev/protocol/discussions/access";
import { DiscussionInviteRequestV1Schema, DiscussionInviteResponseV1Schema, DiscussionRemoveParticipantResponseV1Schema, DiscussionOwnerTransferRequestV1Schema, DiscussionParticipantRouteParamsV1Schema, DiscussionParticipantsListResponseV1Schema, DiscussionRemoveParticipantRequestV1Schema, DiscussionParticipantPolicySetRequestV1Schema } from "@happier-dev/protocol/discussions/participants";
import { listDiscussionGrants, setDiscussionGrant, removeDiscussionGrant, listDiscussionParticipants, inviteDiscussionParticipant, removeDiscussionParticipant, setDiscussionParticipantPolicy, leaveDiscussion, transferDiscussionOwner, readDiscussionRecipientCensus, commitDiscussionRecipientKeyEnvelopes } from "@/app/discussions/accessService";
import { DISCUSSION_SECOND_OPINION_PREVIEW_HTTP_PATH_V1, DiscussionSecondOpinionPreviewInputV1Schema,
    DiscussionSecondOpinionPreviewResponseV1Schema } from '@happier-dev/protocol/discussions/secondOpinion';
import { previewDiscussionSecondOpinion } from '@/app/discussions/secondOpinion';
import { DiscussionAttentionQueryV1Schema, DiscussionAttentionResponseV1Schema } from '@happier-dev/protocol/discussions/api';
import { readDiscussionAttention } from '@/app/discussions/attentionFacts';
import { DiscussionSettingsSetRequestV1Schema, DiscussionSettingsResponseV1Schema } from '@happier-dev/protocol/discussions/settings';
import { getDiscussionSettings, setDiscussionSettings } from '@/app/discussions/settings';
import { registerDiscussionAttachmentRoutes } from './registerDiscussionAttachmentRoutes';

/**
 * The typed result → HTTP mapping.
 *
 * Denial and absence deliberately collapse to 404 for a named discussion so a
 * probe cannot confirm that one exists outside the caller's resource grants. The
 * service decides which of the two it returns; the route never re-derives it.
 */
type DiscussionFailureStatus = 400 | 403 | 404 | 409;

function statusForDiscussionFailure(error: DiscussionFailureCode): DiscussionFailureStatus {
    switch (error) {
        case "discussions_unavailable":
            return 404;
        case "discussion_not_found":
        case "discussion_read_denied":
            return 404;
        case "discussion_post_denied":
        case "discussion_manage_denied":
        case "discussion_access_forbidden":
        case 'team_authentication_required':
        case 'team_authentication_unavailable':
            return 403;
        case "discussion_archived":
        case "discussion_idempotency_conflict":
        case "discussion_owner_transfer_required":
        case "discussion_data_key_changed":
        case "discussion_content_unavailable":
        case "recipient_key_unavailable":
        case DISCUSSION_NOT_TRACKED_CODE_V1:
            return 409;
        default:
            return 400;
    }
}

/**
 * A rejected request body, parameter or query is a caller-visible discussion
 * failure, not a transport crash.
 *
 * The strict Protocol schemas are what keep a public caller from asserting
 * host-stamped Agent provenance or malformed stored content, so their rejection
 * must arrive as this family's own typed 400. Fastify's generic validation body
 * cannot be serialized by the declared error union and would otherwise surface
 * as an opaque 500, hiding exactly the refusal the client needs to see.
 */
function discussionRouteErrorHandler(
    error: FastifyError,
    _request: FastifyRequest,
    reply: FastifyReply,
): unknown {
    if (error.validation) {
        return reply.code(400).send({ error: "discussion_invalid_content" });
    }
    return reply.send(error);
}

const DiscussionErrorResponses = {
    400: DiscussionErrorResponseV1Schema,
    403: DiscussionErrorResponseV1Schema,
    404: DiscussionErrorResponseV1Schema,
    409: DiscussionErrorResponseV1Schema,
} as const;

const PresentUserDiscussionErrorResponses = {
    ...DiscussionErrorResponses,
    403: z.union([DiscussionErrorResponseV1Schema, PresentUserRequiredResponseSchema]),
} as const;

/**
 * Home-scoped Discussion transport.
 *
 * Every route authenticates, feature-gates, parses the Protocol schema and calls
 * exactly one service function. Authorization, encryption-mode enforcement,
 * sequence allocation, idempotency and invalidation all live at that service; a
 * route never re-implements or relaxes them.
 */
export function registerDiscussionRoutes(app: Fastify) {
    registerDiscussionAttachmentRoutes(app, statusForDiscussionFailure, discussionRouteErrorHandler);
    const discussionsApp = createServerFeatureGatedRouteApp(
        app,
        "sessions.conversations",
        process.env,
        // The declared error union is the family's only response vocabulary, so
        // the shared gate refuses with the code this family already maps to 404
        // rather than a body its own 404 schema cannot serialize.
        { error: "discussions_unavailable" },
    );
    const rateLimit = resolveApiHotEndpointRateLimit(process.env, "session.discussions");

    discussionsApp.get(DISCUSSION_HTTP_PATHS_V1.settings, {
        preHandler: app.authenticate, config: { allowApiToken: true, rateLimit }, errorHandler: discussionRouteErrorHandler,
        schema: { params: DiscussionRouteDiscussionParamsV1Schema,
            response: { 200: DiscussionSettingsResponseV1Schema, ...DiscussionErrorResponses } },
    }, async (request, reply) => {
        const result = await getDiscussionSettings({ actorAccountId: request.userId, discussionId: request.params.discussionId,
            authentication: readSessionAccessAuthenticationFromRequest(request) });
        if (!result.ok) return reply.code(statusForDiscussionFailure(result.error)).send({ error: result.error });
        return reply.send(result.value);
    });
    discussionsApp.put(DISCUSSION_HTTP_PATHS_V1.settings, {
        preHandler: [app.authenticate, requireRouteActionAuthority('discussion.settings.set')], config: { rateLimit }, errorHandler: discussionRouteErrorHandler,
        schema: { params: DiscussionRouteDiscussionParamsV1Schema, body: DiscussionSettingsSetRequestV1Schema,
            response: { 200: DiscussionSettingsResponseV1Schema, ...PresentUserDiscussionErrorResponses } },
    }, async (request, reply) => {
        const result = await setDiscussionSettings({ actorAccountId: request.userId, discussionId: request.params.discussionId,
            settings: request.body.settings, authentication: readSessionAccessAuthenticationFromRequest(request) });
        if (!result.ok) return reply.code(statusForDiscussionFailure(result.error)).send({ error: result.error });
        return reply.send(result.value);
    });

    discussionsApp.get(DISCUSSION_HTTP_PATHS_V1.attention, {
        preHandler: app.authenticate, config: { allowApiToken: true, rateLimit }, errorHandler: discussionRouteErrorHandler,
        schema: { querystring: DiscussionAttentionQueryV1Schema,
            response: { 200: DiscussionAttentionResponseV1Schema, ...DiscussionErrorResponses } },
    }, async (request, reply) => {
        const result = await readDiscussionAttention({ actorAccountId: request.userId,
            authentication: readSessionAccessAuthenticationFromRequest(request), ...request.query });
        return result.ok ? reply.send(result.value) : reply.code(statusForDiscussionFailure(result.error)).send({ error: result.error });
    });

    discussionsApp.post(DISCUSSION_SECOND_OPINION_PREVIEW_HTTP_PATH_V1, {
        preHandler: app.authenticate,
        config: { allowApiToken: true, rateLimit },
        errorHandler: discussionRouteErrorHandler,
        schema: { body: DiscussionSecondOpinionPreviewInputV1Schema,
            response: { 200: DiscussionSecondOpinionPreviewResponseV1Schema, ...DiscussionErrorResponses } },
    }, async (request, reply) => {
        return reply.send(await previewDiscussionSecondOpinion({ actorAccountId: request.userId, request: request.body,
            authentication: readSessionAccessAuthenticationFromRequest(request) }));
    });

    discussionsApp.get(DISCUSSION_HTTP_PATHS_V1.collection, {
        preHandler: app.authenticate,
        config: {
            allowApiToken: true,
            rateLimit,
        },
        errorHandler: discussionRouteErrorHandler,
        schema: {
            querystring: DiscussionListQueryV1Schema,
            response: { 200: DiscussionListResponseV1Schema, ...DiscussionErrorResponses },
        },
    }, async (request, reply) => {
        const result = await listDiscussions({
            actorAccountId: request.userId,
            ...(request.query.state === undefined ? {} : { state: request.query.state }),
            ...(request.query.cursor === undefined ? {} : { cursor: request.query.cursor }),
            ...(request.query.anchorSessionId === undefined ? {} : { anchorSessionId: request.query.anchorSessionId }),
            ...(request.query.anchorDocArtifactId === undefined ? {} : { anchorDocArtifactId: request.query.anchorDocArtifactId }),
            ...(request.query.creationLocalId === undefined ? {} : { creationLocalId: request.query.creationLocalId }),
            ...(request.query.sharedWithTeamId === undefined ? {} : { sharedWithTeamId: request.query.sharedWithTeamId }),
            ...(request.query.limit === undefined ? {} : { limit: request.query.limit }),
            authentication: readSessionAccessAuthenticationFromRequest(request),
        });
        if (!result.ok) return reply.code(statusForDiscussionFailure(result.error)).send({ error: result.error });
        return reply.send(result.value);
    });

    discussionsApp.post(DISCUSSION_HTTP_PATHS_V1.collection, {
        preHandler: [app.authenticate, requireRouteActionAuthority("discussion.create")],
        config: { rateLimit },
        errorHandler: discussionRouteErrorHandler,
        schema: {
            body: DiscussionCreateRequestV1Schema,
            response: { 200: DiscussionCreateResponseV1Schema, ...PresentUserDiscussionErrorResponses },
        },
    }, async (request, reply) => {
        if (!isDiscussionRequestWithinTransportBudgetV1(request.body)) {
            return reply.code(400).send({ error: "discussion_invalid_content" });
        }
        const result = await createDiscussion({
            actorAccountId: request.userId,
            request: request.body,
            authentication: readSessionAccessAuthenticationFromRequest(request),
        });
        if (!result.ok) return reply.code(statusForDiscussionFailure(result.error)).send({ error: result.error });
        return reply.send(result.value);
    });

    discussionsApp.get(DISCUSSION_HTTP_PATHS_V1.discussion, {
        preHandler: app.authenticate,
        config: {
            allowApiToken: true,
            rateLimit,
        },
        errorHandler: discussionRouteErrorHandler,
        schema: {
            params: DiscussionRouteDiscussionParamsV1Schema,
            response: { 200: DiscussionDetailsResponseV1Schema, ...PresentUserDiscussionErrorResponses },
        },
    }, async (request, reply) => {
        const result = await getDiscussion({
            actorAccountId: request.userId,
            discussionId: request.params.discussionId,
            authentication: readSessionAccessAuthenticationFromRequest(request),
        });
        if (!result.ok) return reply.code(statusForDiscussionFailure(result.error)).send({ error: result.error });
        return reply.send(result.value);
    });

    discussionsApp.patch(DISCUSSION_HTTP_PATHS_V1.discussion, {
        preHandler: [app.authenticate, requireRouteActionAuthority("discussion.rename")],
        config: { rateLimit },
        errorHandler: discussionRouteErrorHandler,
        schema: {
            params: DiscussionRouteDiscussionParamsV1Schema,
            body: DiscussionRenameRequestV1Schema,
            response: { 200: DiscussionDetailsResponseV1Schema, ...PresentUserDiscussionErrorResponses },
        },
    }, async (request, reply) => {
        if (!isDiscussionRequestWithinTransportBudgetV1(request.body)) {
            return reply.code(400).send({ error: "discussion_invalid_content" });
        }
        const result = await renameDiscussion({
            actorAccountId: request.userId,
            discussionId: request.params.discussionId,
            titleContent: request.body.titleContent,
            authentication: readSessionAccessAuthenticationFromRequest(request),
        });
        if (!result.ok) return reply.code(statusForDiscussionFailure(result.error)).send({ error: result.error });
        return reply.send(result.value);
    });

    discussionsApp.post(DISCUSSION_HTTP_PATHS_V1.archive, {
        preHandler: [app.authenticate, requireRouteActionAuthority("discussion.archive")],
        config: { rateLimit },
        errorHandler: discussionRouteErrorHandler,
        schema: {
            params: DiscussionRouteDiscussionParamsV1Schema,
            response: { 200: DiscussionDetailsResponseV1Schema, ...PresentUserDiscussionErrorResponses },
        },
    }, async (request, reply) => {
        const result = await archiveDiscussion({
            actorAccountId: request.userId,
            discussionId: request.params.discussionId,
            authentication: readSessionAccessAuthenticationFromRequest(request),
        });
        if (!result.ok) return reply.code(statusForDiscussionFailure(result.error)).send({ error: result.error });
        return reply.send(result.value);
    });

    discussionsApp.post(DISCUSSION_HTTP_PATHS_V1.restore, {
        preHandler: [app.authenticate, requireRouteActionAuthority("discussion.restore")],
        config: { rateLimit },
        errorHandler: discussionRouteErrorHandler,
        schema: {
            params: DiscussionRouteDiscussionParamsV1Schema,
            response: { 200: DiscussionDetailsResponseV1Schema, ...PresentUserDiscussionErrorResponses },
        },
    }, async (request, reply) => {
        const result = await restoreDiscussion({
            actorAccountId: request.userId,
            discussionId: request.params.discussionId,
            authentication: readSessionAccessAuthenticationFromRequest(request),
        });
        if (!result.ok) return reply.code(statusForDiscussionFailure(result.error)).send({ error: result.error });
        return reply.send(result.value);
    });

    discussionsApp.get(DISCUSSION_HTTP_PATHS_V1.messages, {
        preHandler: app.authenticate,
        config: {
            allowApiToken: true,
            rateLimit,
        },
        errorHandler: discussionRouteErrorHandler,
        schema: {
            params: DiscussionRouteDiscussionParamsV1Schema,
            querystring: DiscussionMessagesQueryV1Schema,
            response: { 200: DiscussionMessagesResponseV1Schema, ...DiscussionErrorResponses },
        },
    }, async (request, reply) => {
        const result = await readDiscussionMessages({
            actorAccountId: request.userId,
            discussionId: request.params.discussionId,
            ...(request.query.messageId === undefined ? {} : { messageId: request.query.messageId }),
            ...(request.query.localId === undefined ? {} : { localId: request.query.localId }),
            ...(request.query.beforeSeq === undefined ? {} : { beforeSeq: request.query.beforeSeq }),
            ...(request.query.afterSeq === undefined ? {} : { afterSeq: request.query.afterSeq }),
            ...(request.query.throughSeq === undefined ? {} : { throughSeq: request.query.throughSeq }),
            ...(request.query.limit === undefined ? {} : { limit: request.query.limit }),
            authentication: readSessionAccessAuthenticationFromRequest(request),
        });
        if (!result.ok) return reply.code(statusForDiscussionFailure(result.error)).send({ error: result.error });
        return reply.send(result.value);
    });

    discussionsApp.post(DISCUSSION_HTTP_PATHS_V1.messages, {
        preHandler: [app.authenticate, requireRouteActionAuthority("discussion.post")],
        config: {
            rateLimit,
        },
        errorHandler: discussionRouteErrorHandler,
        schema: {
            params: DiscussionRouteDiscussionParamsV1Schema,
            body: DiscussionPostRequestV1Schema,
            response: { 200: DiscussionPostResponseV1Schema, ...PresentUserDiscussionErrorResponses },
        },
    }, async (request, reply) => {
        // Authorship is the authenticated Account. The strict public body has
        // no producer field and this public route never accepts descriptive
        // Agent provenance from its caller; the writer derives it from the
        // verified request authority it already receives.
        if (!isDiscussionRequestWithinTransportBudgetV1(request.body)) {
            return reply.code(400).send({ error: "discussion_invalid_content" });
        }
        const result = await postDiscussionMessage({
            actorAccountId: request.userId,
            discussionId: request.params.discussionId,
            request: request.body,
            authentication: readSessionAccessAuthenticationFromRequest(request),
        });
        if (!result.ok) return reply.code(statusForDiscussionFailure(result.error)).send({ error: result.error });
        return reply.send(result.value);
    });

    discussionsApp.put(DISCUSSION_HTTP_PATHS_V1.read, {
        preHandler: [app.authenticate, requireRouteActionAuthority("discussion.read_state.set")],
        config: { rateLimit },
        errorHandler: discussionRouteErrorHandler,
        schema: {
            params: DiscussionRouteDiscussionParamsV1Schema,
            body: DiscussionReadRequestV1Schema,
            response: { 200: DiscussionReadResponseV1Schema, ...PresentUserDiscussionErrorResponses },
        },
    }, async (request, reply) => {
        const result = await setDiscussionReadCursor({
            actorAccountId: request.userId,
            discussionId: request.params.discussionId,
            lastReadSeq: request.body.lastReadSeq,
            authentication: readSessionAccessAuthenticationFromRequest(request),
        });
        if (!result.ok) return reply.code(statusForDiscussionFailure(result.error)).send({ error: result.error });
        return reply.send(result.value);
    });

    discussionsApp.get(DISCUSSION_HTTP_PATHS_V1.participants, {
        preHandler: app.authenticate, config: { allowApiToken: true, rateLimit }, errorHandler: discussionRouteErrorHandler,
        schema: { params: DiscussionRouteDiscussionParamsV1Schema, response: { 200: DiscussionParticipantsListResponseV1Schema, ...DiscussionErrorResponses } },
    }, async (request, reply) => {
        const result = await listDiscussionParticipants({ actorAccountId: request.userId, discussionId: request.params.discussionId, authentication: readSessionAccessAuthenticationFromRequest(request) });
        if (!result.ok) return reply.code(statusForDiscussionFailure(result.error)).send({ error: result.error });
        return reply.send(result.value);
    });

    discussionsApp.post(DISCUSSION_HTTP_PATHS_V1.invite, {
        preHandler: [app.authenticate, requireRouteActionAuthority("discussion.invite")], config: { rateLimit }, errorHandler: discussionRouteErrorHandler,
        schema: { params: DiscussionRouteDiscussionParamsV1Schema, body: DiscussionInviteRequestV1Schema, response: { 200: DiscussionInviteResponseV1Schema, ...PresentUserDiscussionErrorResponses } },
    }, async (request, reply) => {
        const result = await inviteDiscussionParticipant({ actorAccountId: request.userId, discussionId: request.params.discussionId, request: request.body, authentication: readSessionAccessAuthenticationFromRequest(request) });
        if (!result.ok) return reply.code(statusForDiscussionFailure(result.error)).send({ error: result.error });
        return reply.send(result.value);
    });

    discussionsApp.put(DISCUSSION_HTTP_PATHS_V1.participantPolicy, {
        preHandler: [app.authenticate, requireRouteActionAuthority("discussion.participant.policy.set")], config: { rateLimit }, errorHandler: discussionRouteErrorHandler,
        schema: { params: DiscussionParticipantRouteParamsV1Schema, body: DiscussionParticipantPolicySetRequestV1Schema,
            response: { 200: DiscussionAccessGrantMutationResponseV1Schema, ...PresentUserDiscussionErrorResponses } },
    }, async (request, reply) => {
        const result = await setDiscussionParticipantPolicy({ actorAccountId: request.userId, discussionId: request.params.discussionId,
            request: request.body, authentication: readSessionAccessAuthenticationFromRequest(request) });
        if (!result.ok) return reply.code(statusForDiscussionFailure(result.error)).send({ error: result.error });
        return reply.send(result.value);
    });

    discussionsApp.delete(DISCUSSION_HTTP_PATHS_V1.participant, {
        preHandler: [app.authenticate, requireRouteActionAuthority("discussion.participant.remove")], config: { rateLimit }, errorHandler: discussionRouteErrorHandler,
        schema: { params: DiscussionParticipantRouteParamsV1Schema, body: DiscussionRemoveParticipantRequestV1Schema, response: { 200: DiscussionRemoveParticipantResponseV1Schema, ...PresentUserDiscussionErrorResponses } },
    }, async (request, reply) => {
        const result = await removeDiscussionParticipant({ actorAccountId: request.userId, discussionId: request.params.discussionId, request: request.body, authentication: readSessionAccessAuthenticationFromRequest(request) });
        if (!result.ok) return reply.code(statusForDiscussionFailure(result.error)).send({ error: result.error });
        return reply.send(result.value);
    });

    discussionsApp.post(DISCUSSION_HTTP_PATHS_V1.leave, {
        preHandler: [app.authenticate, requireRouteActionAuthority("discussion.leave")], config: { rateLimit }, errorHandler: discussionRouteErrorHandler,
        // Fastify represents an absent body as null. Both absence and an empty
        // object carry no authority; any caller-supplied operand stays invalid.
        schema: { params: DiscussionRouteDiscussionParamsV1Schema, body: z.nullish(z.strictObject({})), response: { 200: DiscussionLeaveResponseV1Schema, ...PresentUserDiscussionErrorResponses } },
    }, async (request, reply) => {
        const result = await leaveDiscussion({ actorAccountId: request.userId, discussionId: request.params.discussionId, authentication: readSessionAccessAuthenticationFromRequest(request) });
        if (!result.ok) return reply.code(statusForDiscussionFailure(result.error)).send({ error: result.error });
        return reply.send(result.value);
    });

    discussionsApp.put(DISCUSSION_HTTP_PATHS_V1.ownerTransfer, {
        preHandler: [app.authenticate, requireRouteActionAuthority("discussion.owner.transfer")], config: { rateLimit }, errorHandler: discussionRouteErrorHandler,
        schema: { params: DiscussionRouteDiscussionParamsV1Schema, body: DiscussionOwnerTransferRequestV1Schema, response: { 200: DiscussionAccessGrantMutationResponseV1Schema, ...PresentUserDiscussionErrorResponses } },
    }, async (request, reply) => {
        const result = await transferDiscussionOwner({ actorAccountId: request.userId, discussionId: request.params.discussionId, request: request.body, authentication: readSessionAccessAuthenticationFromRequest(request) });
        if (!result.ok) return reply.code(statusForDiscussionFailure(result.error)).send({ error: result.error });
        return reply.send(result.value);
    });

    discussionsApp.get(DISCUSSION_HTTP_PATHS_V1.grants, {
        preHandler: app.authenticate, config: { allowApiToken: true, rateLimit }, errorHandler: discussionRouteErrorHandler,
        schema: { params: DiscussionRouteDiscussionParamsV1Schema, response: { 200: DiscussionAccessGrantsListResponseV1Schema, ...DiscussionErrorResponses } },
    }, async (request, reply) => {
        const result = await listDiscussionGrants({ actorAccountId: request.userId, discussionId: request.params.discussionId, authentication: readSessionAccessAuthenticationFromRequest(request) });
        if (!result.ok) return reply.code(statusForDiscussionFailure(result.error)).send({ error: result.error });
        return reply.send(result.value);
    });

    discussionsApp.put(DISCUSSION_HTTP_PATHS_V1.grants, {
        preHandler: [app.authenticate, requireRouteActionAuthority("discussion.access.grants.set")], config: { rateLimit }, errorHandler: discussionRouteErrorHandler,
        schema: { params: DiscussionRouteDiscussionParamsV1Schema, body: DiscussionAccessGrantSetRequestV1Schema, response: { 200: DiscussionAccessGrantMutationResponseV1Schema, ...PresentUserDiscussionErrorResponses } },
    }, async (request, reply) => {
        const result = await setDiscussionGrant({ actorAccountId: request.userId, discussionId: request.params.discussionId, request: request.body, authentication: readSessionAccessAuthenticationFromRequest(request) });
        if (!result.ok) return reply.code(statusForDiscussionFailure(result.error)).send({ error: result.error });
        return reply.send(result.value);
    });

    discussionsApp.delete(DISCUSSION_HTTP_PATHS_V1.grants, {
        preHandler: [app.authenticate, requireRouteActionAuthority("discussion.access.grants.remove")], config: { rateLimit }, errorHandler: discussionRouteErrorHandler,
        schema: { params: DiscussionRouteDiscussionParamsV1Schema, body: DiscussionAccessGrantRemoveRequestV1Schema, response: { 200: DiscussionAccessGrantMutationResponseV1Schema, ...PresentUserDiscussionErrorResponses } },
    }, async (request, reply) => {
        const result = await removeDiscussionGrant({ actorAccountId: request.userId, discussionId: request.params.discussionId, request: request.body, authentication: readSessionAccessAuthenticationFromRequest(request) });
        if (!result.ok) return reply.code(statusForDiscussionFailure(result.error)).send({ error: result.error });
        return reply.send(result.value);
    });

    discussionsApp.get(DISCUSSION_HTTP_PATHS_V1.recipientCensus, {
        preHandler: app.authenticate, config: { allowApiToken: true, rateLimit }, errorHandler: discussionRouteErrorHandler,
        schema: { params: DiscussionRouteDiscussionParamsV1Schema, response: { 200: DiscussionAccessRecipientCensusResponseV1Schema, ...DiscussionErrorResponses } },
    }, async (request, reply) => {
        const result = await readDiscussionRecipientCensus({ actorAccountId: request.userId, discussionId: request.params.discussionId, authentication: readSessionAccessAuthenticationFromRequest(request) });
        if (!result.ok) return reply.code(statusForDiscussionFailure(result.error)).send({ error: result.error });
        return reply.send(result.value);
    });

    discussionsApp.put(DISCUSSION_HTTP_PATHS_V1.recipientEnvelopes, {
        preHandler: [app.authenticate, requireRouteActionAuthority("discussion.access.grants.set")], config: { rateLimit }, errorHandler: discussionRouteErrorHandler,
        schema: { params: DiscussionRouteDiscussionParamsV1Schema, body: DiscussionRecipientKeyEnvelopeCommitInputV1Schema, response: { 200: DiscussionRecipientKeyEnvelopeCommitResponseV1Schema, ...PresentUserDiscussionErrorResponses } },
    }, async (request, reply) => {
        const result = await commitDiscussionRecipientKeyEnvelopes({ actorAccountId: request.userId, discussionId: request.params.discussionId, request: request.body, authentication: readSessionAccessAuthenticationFromRequest(request) });
        if (!result.ok) return reply.code(statusForDiscussionFailure(result.error)).send({ error: result.error });
        return reply.send(result.value);
    });
}
