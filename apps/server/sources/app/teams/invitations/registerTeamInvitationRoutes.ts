import { z } from "zod/mini";

import { normalizeVerifiedEmail, type NormalizedVerifiedEmail } from '@happier-dev/protocol/auth/verifiedEmail';
import { buildTeamJoinUrl, TeamInvitationAcceptInputV1Schema, TeamInvitationAcceptResultV1Schema, TeamInvitationAcceptApprovalPrepareInputV1Schema, TeamInvitationAcceptApprovalPrepareResultV1Schema, TeamInvitationCreateInputV1Schema, TeamInvitationCreateResultV1Schema, TeamInvitationListInputV1Schema, TeamInvitationPreviewInputV1Schema, TeamInvitationPreviewResultV1Schema, TeamInvitationReissueInputV1Schema, TeamInvitationRevokeInputV1Schema, TeamInvitationRowV1Schema, TeamInvitationReissueResultV1Schema, TeamInvitationsPageV1Schema, type TeamInvitationRowV1 } from '@happier-dev/protocol/teams/invitation';
import { teamErrorHttpStatusV1, TeamErrorV1Schema, type TeamErrorCodeV1, type TeamErrorV1 } from '@happier-dev/protocol/teams';
import {
    createServerFeatureGatePreHandler,
} from "@/app/features/catalog/serverFeatureGate";
import { homeDomainActionPathForMethod } from "@/app/api/routes/actions/homeDomainActionRoute";
import { inTx } from "@/storage/inTx";
import type { Fastify } from "@/app/api/types";
import { resolveApiHotEndpointRateLimit } from "@/app/api/utils/apiRateLimitCatalog";
import { readTeamOperationAuthenticationFromRequest } from "../actorContext";
import { createTeamRouteApp } from "../teamRouteApp";
import { acceptTeamInvitationInTx, TeamInvitationAcceptanceAbort } from "./accept";
import {
    acceptTeamInvitationPostAuthContinuationInTx,
    createTeamInvitationPostAuthContinuationInTx,
} from "./postAuthContinuation";
import { deliverTeamInvitationEmail, type TeamInvitationEmailDeps } from "./emailDelivery";
import {
    createTeamInvitationForActorInTx,
    listTeamInvitationsForActorInTx,
    previewTeamInvitationByTokenInTx,
    resolveTeamInvitationApprovalPreparationInTx,
    reissueTeamInvitationForActorInTx,
    revokeTeamInvitationForActorInTx,
    type JoinScreenHomeIdentity,
    type TeamInvitationAnyError,
} from "./invitationService";

/**
 * The Team invitation transports.
 *
 * These are thin: they authenticate, parse the strict protocol input, call one
 * canonical service, and map its typed result to HTTP. No role comparison, invitation
 * consumption, or membership decision lives here. All paths are POST so a bearer never
 * reaches a URL, a query string, a referrer header, or a browser history entry.
 *
 * Failures speak the one shared Team error vocabulary and its one status mapping, so
 * the same domain result cannot mean two different things depending on which
 * invitation path produced it.
 */

/**
 * The service's own vocabulary is deliberately narrow — an operation declares only the
 * errors it can produce. This is the single translation into the published Team codes;
 * a route that spelled its own would be a second wire contract for one decision.
 */
const TEAM_INVITATION_ERROR_CODE: Record<TeamInvitationAnyError, TeamErrorCodeV1> = {
    forbidden: "team_forbidden",
    team_not_found: "team_not_found",
    team_archived: "team_archived",
    invitation_not_found: "invitation_not_found",
    invitation_not_active: "invitation_not_active",
    // A reused retry identity carrying a different intent is the same class of
    // client error the Team and Group create owners already publish.
    request_conflict: "team_conflict",
    email_delivery_unavailable: "invitation_email_unavailable",
    team_authentication_required: "team_authentication_required",
    team_authentication_unavailable: "team_authentication_unavailable",
    invalid_team_cursor: "invalid_team_cursor",
    team_member_limit_reached: "team_member_limit_reached",
    team_seats_required: "team_seats_required",
};

/**
 * The reply capability every failure path needs: set one of the four declared Team
 * error statuses and send the one shared error envelope. Naming it structurally keeps
 * the helper independent of Fastify's overload shapes, and `send` returns `void`
 * because that is what the route handler's own contract returns.
 */
type TeamErrorReply = Readonly<{
    code: (status: 400 | 403 | 404 | 409 | 503) => {
        send: (payload: TeamErrorV1) => void;
    };
}>;

/**
 * The single domain-result → HTTP mapping for this family, delegating the status to
 * the one shared Team mapping so no route duplicates a status decision.
 */
function sendTeamError(reply: TeamErrorReply, error: TeamErrorCodeV1, details?: TeamErrorV1["details"]): void {
    reply.code(teamErrorHttpStatusV1(error)).send({ error, ...(details === undefined ? {} : { details }) });
}

function sendServiceError(reply: TeamErrorReply, error: TeamInvitationAnyError, details?: TeamErrorV1["details"]): void {
    sendTeamError(reply, TEAM_INVITATION_ERROR_CODE[error], details);
}

// The route and the Action row answer with one declared shape, so a client can
// never be typed against a result the route does not actually send.
const ReissueResultSchema = TeamInvitationReissueResultV1Schema;

const PageSchema = TeamInvitationsPageV1Schema;

const TEAM_ERROR_RESPONSES = {
    400: TeamErrorV1Schema,
    403: TeamErrorV1Schema,
    404: TeamErrorV1Schema,
    409: TeamErrorV1Schema,
    503: TeamErrorV1Schema,
} as const;

export type TeamInvitationRouteDeps = Readonly<{
    /**
     * The configured application origin used to render a join link, and the Homes
     * explicit-target carrier for this Home. Both are supplied by their owners: the
     * origin is a renderer and never the Home authority, and the carrier encoding
     * belongs to the Homes link producer, not to this domain.
     */
    resolveJoinLinkTarget: () => Promise<Readonly<{
        applicationOrigin: string | null;
        homeTarget: string | null;
    }>>;
    /** The Home identity shown on a join screen, from the Homes/auth projection. */
    resolveJoinScreenHomeIdentity: () => Promise<JoinScreenHomeIdentity>;
    /**
     * The mail boundary and whether this Home can currently use it. Readiness is the
     * mail owner's projection, not a local guess: a Home that cannot send must not
     * create an invitation whose only delivery path is mail.
     */
    email: TeamInvitationEmailDeps & Readonly<{ isDeliveryReady: () => boolean | Promise<boolean> }>;
}>;

export function registerTeamInvitationRoutes(app: Fastify, deps: TeamInvitationRouteDeps) {
    const teamsApp = createTeamRouteApp(app);

    /**
     * Renders the one join link for a freshly minted bearer.
     *
     * A Home that has not published both an application origin and the portable Homes
     * carrier returns `null`, which the UI presents as unavailable rather than a link
     * that only works on devices which already know this Home.
     */
    function renderJoinUrl(token: string, target: Awaited<ReturnType<TeamInvitationRouteDeps["resolveJoinLinkTarget"]>>): string | null {
        if (target.applicationOrigin === null || !target.homeTarget?.trim()) return null;
        return buildTeamJoinUrl({
            applicationOrigin: target.applicationOrigin,
            token,
            homeTarget: target.homeTarget,
        });
    }

    /**
     * The Home's name for a mailed invitation: the Home's own published name, or
     * the address the link is rendered at. Neither is invented, and `null` means
     * this Home can render no link at all, so there is nothing to mail.
     */
    async function resolveInvitationHomeName(target: Awaited<ReturnType<TeamInvitationRouteDeps["resolveJoinLinkTarget"]>>): Promise<string | null> {
        if (target.applicationOrigin === null || !target.homeTarget?.trim()) return null;
        const home = await deps.resolveJoinScreenHomeIdentity();
        return home.displayName ?? new URL(target.applicationOrigin).host;
    }

    /** The name is also the admitted fact that this Home can send a portable invitation. */
    async function resolveDeliverableInvitationHomeName(target: Awaited<ReturnType<TeamInvitationRouteDeps["resolveJoinLinkTarget"]>>): Promise<string | null> {
        if (!await deps.email.isDeliveryReady()) return null;
        return resolveInvitationHomeName(target);
    }

    async function deliverAndProject(input: Readonly<{
        invitation: TeamInvitationRowV1;
        joinUrl: string | null;
        teamName: string;
        recipient: NormalizedVerifiedEmail;
        homeName: string;
        inviterAccountId: string;
    }>): Promise<TeamInvitationRowV1> {
        if (input.joinUrl === null) return input.invitation;
        const lastEmailDelivery = await deliverTeamInvitationEmail(deps.email, {
            invitationId: input.invitation.id,
            inviterAccountId: input.inviterAccountId,
            recipient: input.recipient,
            joinUrl: input.joinUrl,
            homeName: input.homeName,
            teamName: input.teamName,
            role: input.invitation.role,
            historyAccess: input.invitation.historyAccess,
            expiresAt: new Date(input.invitation.expiresAt),
        });
        return { ...input.invitation, lastEmailDelivery };
    }

    teamsApp.post(homeDomainActionPathForMethod("teams.invitations.create", "POST"), {
        preHandler: app.authenticate,
        attachValidation: true,
        schema: {
            body: TeamInvitationCreateInputV1Schema,
            response: { 200: TeamInvitationCreateResultV1Schema, ...TEAM_ERROR_RESPONSES },
        },
    }, async (request, reply) => {
        if (request.validationError) return sendTeamError(reply, "invalid_team_input");

        const rawRecipient = request.body.recipientEmail;
        // Normalization belongs to the Account/email owner; the transaction receives
        // its normalized value and the mail owner's current bounded readiness fact.
        const recipient = rawRecipient === null ? null : normalizeVerifiedEmail(rawRecipient);
        if (rawRecipient !== null && recipient === null) return sendTeamError(reply, "invalid_team_input");
        const joinLinkTarget = await deps.resolveJoinLinkTarget();
        const homeName = recipient === null ? null : await resolveDeliverableInvitationHomeName(joinLinkTarget);
        const emailDeliveryAvailable = recipient === null || homeName !== null;

        const result = await inTx(async (tx) => createTeamInvitationForActorInTx(tx, {
            teamId: request.body.teamId,
            actorAccountId: request.userId,
            role: request.body.role,
            historyAccess: request.body.historyAccess,
            recipientEmailNormalized: recipient?.normalizedEmail ?? null,
            emailDeliveryAvailable,
            requestKey: request.body.requestKey,
            authentication: readTeamOperationAuthenticationFromRequest(request),
        }), { isolationLevel: "ReadCommitted" /* Complete Account admission and the Team guard precede fresh authority and replay reads. */ });
        if (!result.ok) return sendServiceError(reply, result.error, result.details);

        // A replayed intent mints nothing and delivers nothing: the mail for this
        // invitation was already attempted once and its recorded result is on the
        // row. Re-sending here would be exactly the hidden repeated delivery that
        // explicit reissue exists to replace.
        const { token } = result.value;
        if (token === null) {
            return reply.send({ invitation: result.value.invitation, joinUrl: null });
        }

        // An email-bound bearer goes only to the mail boundary. The manager never
        // receives it, so a redacted or lost result recovers by explicit reissue.
        if (recipient) {
            if (homeName === null) {
                return reply.send({ invitation: result.value.invitation, joinUrl: null });
            }
            return reply.send({
                invitation: await deliverAndProject({
                    invitation: result.value.invitation,
                    joinUrl: renderJoinUrl(token, joinLinkTarget),
                    teamName: result.value.teamName,
                    recipient,
                    homeName,
                    inviterAccountId: request.userId,
                }),
                joinUrl: null,
            });
        }
        return reply.send({
            invitation: result.value.invitation,
            joinUrl: renderJoinUrl(token, joinLinkTarget),
        });
    });

    teamsApp.post(homeDomainActionPathForMethod("teams.invitations.list", "POST"), {
        preHandler: app.authenticate,
        attachValidation: true,
        schema: {
            body: TeamInvitationListInputV1Schema,
            response: { 200: PageSchema, ...TEAM_ERROR_RESPONSES },
        },
    }, async (request, reply) => {
        if (request.validationError) return sendTeamError(reply, "invalid_team_input");
        const result = await inTx(async (tx) => listTeamInvitationsForActorInTx(tx, {
            teamId: request.body.teamId,
            actorAccountId: request.userId,
            cursor: request.body.cursor,
            limit: request.body.limit,
            state: request.body.state,
            authentication: readTeamOperationAuthenticationFromRequest(request),
        }));
        if (!result.ok) return sendServiceError(reply, result.error);
        // The same readiness the create and reissue transactions enforce, published
        // once to the only authenticated read that has already proved invitation
        // authority. A manager surface can then withhold the Email offer instead of
        // presenting one this Home would refuse — and, when this Home can render no
        // join link at all, say that instead of offering a link to reissue.
        const homeName = await resolveInvitationHomeName(await deps.resolveJoinLinkTarget());
        return reply.send({
            ...result.value,
            emailDelivery: await deps.email.isDeliveryReady() && homeName !== null ? "available" : "unavailable",
            linkDelivery: homeName === null ? "unavailable" : "available",
        });
    });

    teamsApp.post(homeDomainActionPathForMethod("teams.invitations.revoke", "POST"), {
        preHandler: app.authenticate,
        attachValidation: true,
        schema: {
            body: TeamInvitationRevokeInputV1Schema,
            response: { 200: TeamInvitationRowV1Schema, ...TEAM_ERROR_RESPONSES },
        },
    }, async (request, reply) => {
        if (request.validationError) return sendTeamError(reply, "invalid_team_input");
        const result = await inTx(async (tx) => revokeTeamInvitationForActorInTx(tx, {
            teamId: request.body.teamId,
            actorAccountId: request.userId,
            invitationId: request.body.invitationId,
            authentication: readTeamOperationAuthenticationFromRequest(request),
        }), { isolationLevel: "ReadCommitted" /* Existing Team admission and conditional invitation retirement own the single-use decision. */ });
        if (!result.ok) return sendServiceError(reply, result.error);
        return reply.send(result.value);
    });

    /**
     * Retry and Change email are the same operation: the previous bearer stops working
     * and a fresh seven-day invitation carries the same role and history intent.
     */
    teamsApp.post(homeDomainActionPathForMethod("teams.invitations.reissue", "POST"), {
        preHandler: app.authenticate,
        attachValidation: true,
        schema: {
            body: TeamInvitationReissueInputV1Schema,
            response: { 200: ReissueResultSchema, ...TEAM_ERROR_RESPONSES },
        },
    }, async (request, reply) => {
        if (request.validationError) return sendTeamError(reply, "invalid_team_input");

        const rawRecipient = request.body.recipientEmail;
        // A supplied address is Change email and must satisfy the delivery
        // preconditions now. An absent address is Retry, whose effective recipient
        // is only known once the stored row is read, so the transaction is told
        // whether mail is available and refuses rather than retiring a working
        // bearer for a replacement this Home could not deliver.
        const replacementRecipient = rawRecipient === null ? null : normalizeVerifiedEmail(rawRecipient);
        if (rawRecipient !== null && replacementRecipient === null) {
            return sendTeamError(reply, "invalid_team_input");
        }
        // Descriptor/mail readiness is an external projection, not transactional
        // state. Resolve it before opening the membership/invitation transaction;
        // the service receives only the bounded fact it needs for its atomic
        // revoke-and-replace decision.
        const joinLinkTarget = await deps.resolveJoinLinkTarget();
        const homeName = await resolveDeliverableInvitationHomeName(joinLinkTarget);
        const emailDeliveryAvailable = homeName !== null;

        const result = await inTx(async (tx) => reissueTeamInvitationForActorInTx(tx, {
            teamId: request.body.teamId,
            actorAccountId: request.userId,
            invitationId: request.body.invitationId,
            replacementRecipientEmailNormalized: replacementRecipient?.normalizedEmail ?? null,
            requestKey: request.body.requestKey,
            emailDeliveryAvailable,
            authentication: readTeamOperationAuthenticationFromRequest(request),
        }), { isolationLevel: "ReadCommitted" /* Team admission precedes current authority; conditional old-row retirement rolls back a losing replacement. */ });
        if (!result.ok) return sendServiceError(reply, result.error);

        const { token, recipientEmailNormalized } = result.value;
        if (token === null) {
            return reply.send({
                previous: result.value.previous,
                replacement: result.value.replacement,
                joinUrl: null,
            });
        }

        // The replacement carries a recipient whether it was supplied or preserved,
        // so Retry on an email-bound invitation re-delivers to the same person.
        if (recipientEmailNormalized !== null) {
            const recipient = replacementRecipient
                ?? normalizeVerifiedEmail(recipientEmailNormalized);
            if (recipient === null || homeName === null) {
                return reply.send({
                    previous: result.value.previous,
                    replacement: result.value.replacement,
                    joinUrl: null,
                });
            }
            return reply.send({
                previous: result.value.previous,
                replacement: await deliverAndProject({
                    invitation: result.value.replacement,
                    joinUrl: renderJoinUrl(token, joinLinkTarget),
                    teamName: result.value.teamName,
                    recipient,
                    homeName,
                    inviterAccountId: request.userId,
                }),
                joinUrl: null,
            });
        }
        return reply.send({
            previous: result.value.previous,
            replacement: result.value.replacement,
            joinUrl: renderJoinUrl(token, joinLinkTarget),
        });
    });

    /**
     * The public pre-authentication preview.
     *
     * It is the pre-auth transport of the same preview owner, not a second preview
     * implementation, and it is a POST so the bearer stays out of the URL even here.
     * It never consumes and never mutates, so a mail-security scanner following a link
     * cannot join a Team.
     *
     * This route sits on the bare app with its own parameterized gate so a capable
     * Home with Teams administratively disabled answers the declared typed
     * `{ outcome: "feature_unavailable" }` result instead of the family's generic
     * 404 body — the join screen must distinguish an operator's choice from an old
     * binary (child 05 §8/§9). The enabled/disabled decision itself stays in the
     * shared feature-gate owner; only this route's typed body and status differ.
     */
    app.post(homeDomainActionPathForMethod("teams.invitations.preview", "POST"), {
        preHandler: createServerFeatureGatePreHandler(
            "teams",
            process.env,
            { outcome: "feature_unavailable" },
            200,
        ),
        config: { rateLimit: resolveApiHotEndpointRateLimit(process.env, "auth.entry") },
        attachValidation: true,
        schema: {
            body: TeamInvitationPreviewInputV1Schema,
            response: { 200: TeamInvitationPreviewResultV1Schema },
        },
    }, async (request, reply) => {
        if (request.validationError) return reply.send({ outcome: "unavailable" });
        const home = await deps.resolveJoinScreenHomeIdentity();
        const result = await inTx(async (tx) => previewTeamInvitationByTokenInTx(tx, {
            token: request.body.token,
            home,
        }));
        return reply.send(result);
    });

    /**
     * Before a token-bearing accept request may become a deferred Approval Artifact,
     * exchange the bearer for the existing Account-bound continuation contract.
     * The active-invitation resolver owns validity and preview projection; this route
     * adds no second invitation decision and never persists or returns the bearer.
     */
    teamsApp.post(homeDomainActionPathForMethod("teams.invitations.accept.prepareApproval", "POST"), {
        preHandler: app.authenticate,
        config: { rateLimit: resolveApiHotEndpointRateLimit(process.env, "auth.entry") },
        attachValidation: true,
        schema: {
            body: TeamInvitationAcceptApprovalPrepareInputV1Schema,
            response: { 200: TeamInvitationAcceptApprovalPrepareResultV1Schema },
        },
    }, async (request, reply) => {
        if (request.validationError) return reply.send({ outcome: "unavailable" });
        const home = await deps.resolveJoinScreenHomeIdentity();
        const result = await inTx(async (tx) => {
            const prepared = await resolveTeamInvitationApprovalPreparationInTx(tx, {
                token: request.body.token,
                home,
            });
            if (prepared === null) return { outcome: "unavailable" } as const;
            const continuation = await createTeamInvitationPostAuthContinuationInTx(tx, {
                accountId: request.userId,
                teamId: prepared.teamId,
                invitationId: prepared.invitationId,
                tokenHash: prepared.tokenHash,
                expiresAt: prepared.expiresAt,
            });
            return { outcome: "ok", continuation, preview: prepared.preview } as const;
        });
        return reply.send(result);
    });

    /**
     * Acceptance always requires an authenticated Home identity and an explicit
     * request; there is no GET carrier and no automatic acceptance on link open.
     * Every well-formed terminal outcome is a 200 typed result because each is a
     * normal, user-recoverable answer. A malformed authenticated body remains a
     * strict 400 `invalid_team_input`; only the unauthenticated preview coarsens
     * malformed bearer input to avoid becoming an enumeration oracle.
     */
    teamsApp.post(homeDomainActionPathForMethod("teams.invitations.accept", "POST"), {
        preHandler: app.authenticate,
        attachValidation: true,
        schema: {
            body: TeamInvitationAcceptInputV1Schema,
            response: { 200: TeamInvitationAcceptResultV1Schema, ...TEAM_ERROR_RESPONSES },
        },
    }, async (request, reply) => {
        if (request.validationError) return sendTeamError(reply, "invalid_team_input");
        const result = await inTx(async (tx) => "continuation" in request.body
            ? acceptTeamInvitationPostAuthContinuationInTx(tx, {
                continuation: request.body.continuation,
                accountId: request.userId,
            })
            : acceptTeamInvitationInTx(tx, {
                token: request.body.token,
                accountId: request.userId,
            }), { isolationLevel: "ReadCommitted" /* Existing Team admission precedes policy reads; conditional consume owns the single-use winner. */ }).catch((error: unknown) => {
            if (error instanceof TeamInvitationAcceptanceAbort) return error.result;
            throw error;
        });
        return reply.send(result);
    });
}
