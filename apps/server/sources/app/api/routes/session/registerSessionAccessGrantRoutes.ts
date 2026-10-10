import { z } from "zod";
import {
    SessionAccessGrantsListRequestV1Schema, SessionAccessGrantsListResponseV1Schema,
    SetSessionAccessGrantRequestV1Schema, SetSessionAccessGrantResponseV1Schema,
    RemoveSessionAccessGrantRequestV1Schema, RemoveSessionAccessGrantResponseV1Schema,
    SetSessionAccessContextRequestV1Schema, SetSessionAccessContextResponseV1Schema,
    ResolveSessionAccessPrincipalsRequestV1Schema, ResolveSessionAccessPrincipalsResponseV1Schema,
} from "@happier-dev/protocol";
import { ACCOUNT_DISPLAY_PROFILE_SELECT } from "@/app/account/profile/accountDisplayProfile";
import { createServerFeatureGatedRouteApp } from "@/app/features/catalog/serverFeatureGate";
import { inspectSessionAccessGrants } from "@/app/session/access/sessionAccessGrantInspection";
import { assertSessionAccessManageAccessInTx, putSessionAccessGrantInTx, deleteSessionAccessGrantInTx, setSessionAccessContextInTx, type SessionAccessGrantErrorCode } from "@/app/session/access/sessionAccessGrantService";
import { projectReleasedDirectShareEvent, scheduleReleasedDirectShareEvent } from "@/app/session/access/publishSessionAccessChange";
import { readSessionAccessAuthenticationFromRequest } from "@/app/session/access/sessionAccessAuthentication";
import { validateRequiredTeamVisibilityInTx } from "@/app/teams/credentials/sessionBinding";
import { SessionTeamCredentialBindingRejectionV1Schema } from "@happier-dev/protocol/teams";
import { inTx } from "@/storage/inTx";
import { type Fastify } from "../../types";
import { resolveSessionAccessPrincipalsInTx } from "@/app/session/access/sessionAccessPrincipalResolution";

const ErrorSchema = z.object({ error: z.string(), reason: SessionTeamCredentialBindingRejectionV1Schema.optional() });
const errors = { 400: ErrorSchema, 403: ErrorSchema, 404: ErrorSchema, 409: ErrorSchema, 503: ErrorSchema };

function errorStatus(error: SessionAccessGrantErrorCode): 400 | 403 | 404 | 409 | 503 {
    if (error === "session_access_authentication_unavailable") return 503;
    if (error === "session_access_forbidden"
        || error === "session_access_permission_delegation_forbidden"
        || error === "session_access_authentication_required"
        || error === "session_access_external_sharing_requires_team_admin"
        || error === "session_access_external_sharing_disabled") return 403;
    if (error === "session_access_session_not_found" || error === "session_access_subject_not_found") return 404;
    if (error === "session_access_team_policy_required") return 409;
    return 400;
}

/** Current desired-state transport; the grant service owns admission, persistence and access effects. */
export function registerSessionAccessGrantRoutes(app: Fastify) {
    const collaborationApp = createServerFeatureGatedRouteApp(app, "sharing.session");
    collaborationApp.post("/v1/session-access/principals/resolve", {
        preHandler: app.authenticate,
        schema: {
            body: ResolveSessionAccessPrincipalsRequestV1Schema,
            response: { 200: ResolveSessionAccessPrincipalsResponseV1Schema },
        },
    }, async (request, reply) => {
        const value = await inTx((tx) => resolveSessionAccessPrincipalsInTx({
            tx,
            actorAccountId: request.userId,
            subjects: request.body.subjects,
            ...(request.body.creationTeamId === undefined ? {} : { creationTeamId: request.body.creationTeamId }),
            authentication: readSessionAccessAuthenticationFromRequest(request),
        }), { readOnly: true });
        return reply.send(value);
    });
    collaborationApp.post("/v2/sessions/access-grants/list", {
        preHandler: app.authenticate,
        schema: { body: SessionAccessGrantsListRequestV1Schema, response: { 200: SessionAccessGrantsListResponseV1Schema, ...errors } },
    }, async (request, reply) => {
        const result = await inspectSessionAccessGrants({
            actorAccountId: request.userId,
            sessionId: request.body.sessionId,
            authentication: readSessionAccessAuthenticationFromRequest(request),
        });
        if (!result.ok) return reply.code(errorStatus(result.error)).send({ error: result.error });
        return reply.send(result.value);
    });
    collaborationApp.post("/v2/sessions/access-grants/set", {
        preHandler: app.authenticate,
        schema: { body: SetSessionAccessGrantRequestV1Schema, response: { 200: SetSessionAccessGrantResponseV1Schema, ...errors } },
    }, async (request, reply) => {
        const { sessionId, subject, accessLevel, canApprovePermissions, accountEnvelopeInput, requiredTeamCredential } = request.body;
        const authentication = readSessionAccessAuthenticationFromRequest(request);
        const result = await inTx(async (tx) => {
            // A compound Team-credential binding must not reveal whether a
            // Session/resource exists before the canonical access owner admits
            // this actor as its manager. The grant writer repeats this check
            // after the binding validation in the same transaction.
            const accessError = await assertSessionAccessManageAccessInTx(tx, {
                actorAccountId: request.userId, sessionId, authentication,
            });
            if (accessError) return { ok: false as const, error: accessError };
            if (requiredTeamCredential) {
                const admission = subject.kind === "team"
                    ? await validateRequiredTeamVisibilityInTx(tx, {
                        sessionId, accountId: request.userId, consentTeamId: subject.teamId,
                        requiredTeamCredential, authentication,
                    })
                    : { ok: false as const, reason: "invalid_input" as const };
                if (!admission.ok) return {
                    ok: false as const,
                    error: "session_team_credential_binding_rejected" as const,
                    reason: admission.reason,
                };
            }
            const mutation = await putSessionAccessGrantInTx(tx, {
                actorAccountId: request.userId, sessionId, subject,
                grant: { accessLevel, canApprovePermissions },
                authentication,
                ...(accountEnvelopeInput === undefined ? {} : { accountEnvelopeInput }),
            });
            if (mutation.ok && mutation.changed && mutation.directShare) {
                const recipientAccountId = mutation.directShare.sharedWithUserId;
                scheduleReleasedDirectShareEvent(tx, {
                    recipientAccountId,
                    cursor: mutation.effects.accountCursors.get(recipientAccountId) ?? 0,
                    event: projectReleasedDirectShareEvent({
                        recipientAccountId,
                        effects: mutation.effects,
                        directShare: mutation.directShare,
                        directShareRemoved: false,
                    }),
                    sharedByUser: await tx.account.findUnique({ where: { id: mutation.directShare.sharedByUserId }, select: ACCOUNT_DISPLAY_PROFILE_SELECT }),
                });
            }
            return mutation;
        });
        if (!result.ok) {
            if (result.error === "session_team_credential_binding_rejected") {
                return reply.code(409).send({ error: result.error, reason: result.reason });
            }
            return reply.code(errorStatus(result.error)).send({ error: result.error });
        }
        const grant = result.subject.kind === "team"
            ? {
                subject: result.subject,
                ...result.value,
                requiredByTeamPolicy: result.requiredByTeamPolicy,
            }
            : result.subject.kind === "group"
                ? {
                    subject: result.subject,
                    ...result.value,
                }
                : {
                    subject: result.subject,
                    ...result.value,
                };
        return reply.send({ changed: result.changed, grant });
    });
    collaborationApp.post("/v2/sessions/access-grants/remove", {
        preHandler: app.authenticate,
        schema: { body: RemoveSessionAccessGrantRequestV1Schema, response: { 200: RemoveSessionAccessGrantResponseV1Schema, ...errors } },
    }, async (request, reply) => {
        const result = await inTx(async (tx) => {
            const mutation = await deleteSessionAccessGrantInTx(tx, {
                actorAccountId: request.userId,
                ...request.body,
                authentication: readSessionAccessAuthenticationFromRequest(request),
            });
            if (mutation.ok && mutation.changed && mutation.removedDirectShare) {
                const recipientAccountId = mutation.removedDirectShare.sharedWithUserId;
                scheduleReleasedDirectShareEvent(tx, {
                    recipientAccountId,
                    cursor: mutation.effects.accountCursors.get(recipientAccountId) ?? 0,
                    event: projectReleasedDirectShareEvent({
                        recipientAccountId,
                        effects: mutation.effects,
                        directShare: mutation.removedDirectShare,
                        directShareRemoved: true,
                    }),
                    sharedByUser: null,
                });
            }
            return mutation;
        });
        if (!result.ok) return reply.code(errorStatus(result.error)).send({ error: result.error });
        return reply.send({ changed: result.changed, subject: result.subject });
    });
    collaborationApp.post("/v2/sessions/access-context/set", {
        preHandler: app.authenticate,
        schema: { body: SetSessionAccessContextRequestV1Schema, response: { 200: SetSessionAccessContextResponseV1Schema, ...errors } },
    }, async (request, reply) => {
        const result = await inTx(async (tx) => await setSessionAccessContextInTx(tx, {
            actorAccountId: request.userId,
            sessionId: request.body.sessionId,
            primaryTeamId: request.body.primaryTeamId,
            authentication: readSessionAccessAuthenticationFromRequest(request),
        }));
        if (!result.ok) return reply.code(errorStatus(result.error)).send({ error: result.error });
        return reply.send({ changed: result.changed, primaryTeamId: result.primaryTeamId });
    });
}
