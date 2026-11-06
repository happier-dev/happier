import { AnyClientUpgradeRequiredV1Schema, CLIENT_UPGRADE_REQUIRED_ERROR_CODE, CLIENT_UPGRADE_REQUIRED_HTTP_STATUS } from '@happier-dev/protocol/clientCompatibility/upgradeRequiredV1';
import { SESSION_ORGANIZATION_CURRENT_PROJECTION_VERSION, SESSION_ORGANIZATION_LEGACY_MAX_ATTENTION_STANDINGS } from '@happier-dev/protocol/sessions/organization/constants';
import { CreateOrUpdateSessionOrganizationFolderRequestSchema, CreateOrUpdateSessionOrganizationFolderResponseSchema, CreateOrUpdateSessionOrganizationTagRequestSchema, CreateOrUpdateSessionOrganizationTagResponseSchema, DeleteSessionOrganizationLabelRequestSchema, DeleteSessionOrganizationLabelResponseSchema, DeleteSessionOrganizationFolderRequestSchema, DeleteSessionOrganizationFolderResponseSchema, DeleteSessionOrganizationTagRequestSchema, DeleteSessionOrganizationTagResponseSchema, ImportLegacySessionOrganizationRequestSchema, ImportLegacySessionOrganizationResponseSchema, MoveSessionFolderAssignmentsRequestSchema, MoveSessionFolderAssignmentsResponseSchema, ReorderSessionOrganizationRequestSchema, ReorderSessionOrganizationResponseSchema, SetSessionFolderAssignmentRequestSchema, SetSessionFolderAssignmentResponseSchema, SetSessionPinRequestSchema, SetSessionPinResponseSchema, MutateSessionTagAssignmentsRequestSchema, SetSessionTagAssignmentsResponseSchema, UpsertSessionOrganizationLabelRequestSchema, UpsertSessionOrganizationLabelResponseSchema } from '@happier-dev/protocol/sessions/organization/mutations';
import { SessionOrganizationSnapshotRequestSchema, SessionOrganizationSnapshotResponseSchema, sessionOrganizationSnapshotRequestFromQueryV1 } from '@happier-dev/protocol/sessions/organization/snapshot';
import { SetSessionAttentionStandingRequestSchema, SetSessionAttentionStandingResponseSchema } from '@happier-dev/protocol/sessions/organization/standings';
import { SetSessionAppearanceRequestSchema, SetSessionAppearanceResponseSchema } from '@happier-dev/protocol/sessions/organization/appearances';
import { z } from "zod/mini";

import { enforceCurrentAccountStoredContentCompatibilityForHttpRequest } from "@/app/clientCompatibility/accountStoredContentCompatibility";
import { createServerFeatureGatedRouteApp } from "@/app/features/catalog/serverFeatureGate";
import {
    canAccessSyncedSessionForOrganization,
    canAccessVisibleUnarchivedSessionForOrganization,
} from "@/app/session/organization/access";
import {
    deleteSessionOrganizationFolder,
    deleteSessionOrganizationLabel,
    deleteSessionOrganizationTag,
    importLegacySessionOrganization,
    moveSessionFolderAssignments,
    setSessionAttentionStanding,
    setSessionAppearance,
    setSessionFolderAssignment,
    setSessionPin,
    setSessionTagAssignments,
    upsertSessionOrganizationLabel,
    upsertSessionOrganizationTag,
    upsertSessionOrganizationFolder,
} from "@/app/session/organization/organizationMutations";
import { fetchSessionOrganizationSnapshot } from "@/app/session/organization/organizationQueries";
import { reorderSessionOrganization, reorderSessionPins } from "@/app/session/organization/organizationOrdering";
import { readSessionAccessAuthenticationFromRequest } from "@/app/session/access/sessionAccessAuthentication";
import { type Fastify } from "../../types";

const sessionIdParamsSchema = z.object({
    sessionId: z.string().check(z.minLength(1)),
});

const folderIdParamsSchema = z.object({
    folderId: z.string().check(z.minLength(1)),
});

const tagIdParamsSchema = z.object({
    tagId: z.string().check(z.minLength(1)),
});

export function registerSessionOrganizationRoutes(app: Fastify) {
    app.get("/v2/session-organization", {
        preHandler: app.authenticate,
        schema: {
            response: {
                200: SessionOrganizationSnapshotResponseSchema,
                400: z.object({ error: z.literal("invalid-session-organization-snapshot-request") }),
                426: AnyClientUpgradeRequiredV1Schema,
            },
        },
    }, async (request, reply) => {
        const parsedRequest = SessionOrganizationSnapshotRequestSchema.safeParse(sessionOrganizationSnapshotRequestFromQueryV1(request.query));
        if (!parsedRequest.success) {
            return reply.code(400).send({ error: "invalid-session-organization-snapshot-request" });
        }

        const snapshot = await fetchSessionOrganizationSnapshot({
            accountId: request.userId,
            request: parsedRequest.data,
            authentication: readSessionAccessAuthenticationFromRequest(request),
        });

        // Released strict readers cannot parse more than 500 standings. Keep all data and
        // writes intact; only this incompatible read requires an updated projection reader.
        if (
            parsedRequest.data.projectionVersion !== SESSION_ORGANIZATION_CURRENT_PROJECTION_VERSION
            && (snapshot.attentionStandings?.length ?? 0) > SESSION_ORGANIZATION_LEGACY_MAX_ATTENTION_STANDINGS
        ) {
            return reply.code(CLIENT_UPGRADE_REQUIRED_HTTP_STATUS).send({
                error: CLIENT_UPGRADE_REQUIRED_ERROR_CODE,
                requirement: {
                    v: 1,
                    kind: "session-organization",
                    minimumProtocolVersion: SESSION_ORGANIZATION_CURRENT_PROJECTION_VERSION,
                },
            });
        }

        const includesCurrentOnlyDisplayState = [
            ...snapshot.folders,
            ...snapshot.tags,
            ...snapshot.labels,
            ...(snapshot.sessionAppearances ?? []),
        ].some((entry) => entry.displayState?.status === "unavailable");
        if (
            includesCurrentOnlyDisplayState
            && !await enforceCurrentAccountStoredContentCompatibilityForHttpRequest(
                request,
                reply,
            )
        ) {
            return;
        }

        return reply.send({ snapshot });
    });

    app.put("/v2/session-organization/pins/:sessionId", {
        preHandler: app.authenticate,
        config: { apiTokenSessionAction: 'session.organization.pin.set',
            restrictedCredentialBinding: { scope: 'session', session: 'params.sessionId', allowSessionRuntime: false } },
        schema: {
            params: sessionIdParamsSchema,
            body: SetSessionPinRequestSchema,
            response: {
                200: SetSessionPinResponseSchema,
                400: z.object({ error: z.literal("invalid-session-pin") }),
                404: z.object({ error: z.literal("Session not found") }),
                409: z.object({ error: z.literal("session-pin-limit-exceeded") }),
            },
        },
    }, async (request, reply) => {
        const parsedParams = sessionIdParamsSchema.safeParse(request.params);
        const parsedBody = SetSessionPinRequestSchema.safeParse(request.body);
        if (!parsedParams.success || !parsedBody.success) {
            return reply.code(400).send({ error: "invalid-session-pin" });
        }

        const visible = parsedBody.data.pinned
            ? await canAccessVisibleUnarchivedSessionForOrganization({
                accountId: request.userId,
                sessionId: parsedParams.data.sessionId,
                authentication: readSessionAccessAuthenticationFromRequest(request),
            })
            : await canAccessSyncedSessionForOrganization({
                accountId: request.userId,
                sessionId: parsedParams.data.sessionId,
                authentication: readSessionAccessAuthenticationFromRequest(request),
            });
        if (!visible) {
            return reply.code(404).send({ error: "Session not found" });
        }

        const result = await setSessionPin({
            accountId: request.userId,
            sessionId: parsedParams.data.sessionId,
            request: parsedBody.data,
            authentication: readSessionAccessAuthenticationFromRequest(request),
        });
        if ("error" in result) {
            if (result.error === "session-not-found") {
                return reply.code(404).send({ error: "Session not found" });
            }
            return reply.code(409).send({ error: result.error });
        }

        return reply.send(result);
    });

    app.put("/v2/session-organization/attention-standings/:sessionId", {
        preHandler: app.authenticate,
        config: { apiTokenSessionAction: 'session.attention.set',
            restrictedCredentialBinding: { scope: 'session', session: 'params.sessionId', allowSessionRuntime: false } },
        schema: {
            params: sessionIdParamsSchema,
            body: SetSessionAttentionStandingRequestSchema,
            response: {
                200: SetSessionAttentionStandingResponseSchema,
                400: z.object({ error: z.literal("invalid-session-attention-standing") }),
                404: z.object({ error: z.literal("Session not found") }),
            },
        },
    }, async (request, reply) => {
        const parsedParams = sessionIdParamsSchema.safeParse(request.params);
        const parsedBody = SetSessionAttentionStandingRequestSchema.safeParse(request.body);
        if (!parsedParams.success || !parsedBody.success) {
            return reply.code(400).send({ error: "invalid-session-attention-standing" });
        }

        const visible = parsedBody.data.standing === null || parsedBody.data.remindAt === null
            ? await canAccessSyncedSessionForOrganization({
                accountId: request.userId,
                sessionId: parsedParams.data.sessionId,
                authentication: readSessionAccessAuthenticationFromRequest(request),
            })
            : await canAccessVisibleUnarchivedSessionForOrganization({
                accountId: request.userId,
                sessionId: parsedParams.data.sessionId,
                authentication: readSessionAccessAuthenticationFromRequest(request),
            });
        if (!visible) {
            return reply.code(404).send({ error: "Session not found" });
        }

        const result = await setSessionAttentionStanding({
            accountId: request.userId,
            sessionId: parsedParams.data.sessionId,
            request: parsedBody.data,
            authentication: readSessionAccessAuthenticationFromRequest(request),
        });
        if ("error" in result) {
            return reply.code(404).send({ error: "Session not found" });
        }

        return reply.send(result);
    });

    app.put("/v2/session-organization/appearances/:sessionId", {
        preHandler: app.authenticate,
        schema: {
            params: sessionIdParamsSchema,
            body: SetSessionAppearanceRequestSchema,
            response: {
                200: SetSessionAppearanceResponseSchema,
                400: z.object({ error: z.literal("invalid-session-appearance") }),
                404: z.object({ error: z.literal("Session not found") }),
                409: z.object({ error: z.literal("session-appearance-limit-exceeded") }),
            },
        },
    }, async (request, reply) => {
        const parsedParams = sessionIdParamsSchema.safeParse(request.params);
        const parsedBody = SetSessionAppearanceRequestSchema.safeParse(request.body);
        if (!parsedParams.success || !parsedBody.success) return reply.code(400).send({ error: "invalid-session-appearance" });
        const access = { accountId: request.userId, sessionId: parsedParams.data.sessionId,
            authentication: readSessionAccessAuthenticationFromRequest(request) };
        const visible = parsedBody.data.display === null
            ? await canAccessSyncedSessionForOrganization(access)
            : await canAccessVisibleUnarchivedSessionForOrganization(access);
        if (!visible) return reply.code(404).send({ error: "Session not found" });
        const result = await setSessionAppearance({ ...access, request: parsedBody.data });
        if ("error" in result) {
            if (result.error === "session-not-found") return reply.code(404).send({ error: "Session not found" });
            if (result.error === "invalid-display-envelope") return reply.code(400).send({ error: "invalid-session-appearance" });
            return reply.code(409).send({ error: result.error });
        }
        return reply.send(result);
    });

    app.put("/v2/session-organization/order", {
        preHandler: app.authenticate,
        schema: {
            body: ReorderSessionOrganizationRequestSchema,
            response: {
                200: ReorderSessionOrganizationResponseSchema,
                400: z.object({ error: z.literal("invalid-session-organization-order") }),
            },
        },
    }, async (request, reply) => {
        const parsedBody = ReorderSessionOrganizationRequestSchema.safeParse(request.body);
        if (!parsedBody.success) {
            return reply.code(400).send({ error: "invalid-session-organization-order" });
        }

        if (parsedBody.data.scopeKind === "pinned") {
            if (parsedBody.data.entries.some((entry) => entry.itemKind !== "session")) {
                return reply.code(400).send({ error: "invalid-session-organization-order" });
            }
            const result = await reorderSessionPins({
                accountId: request.userId,
                request: parsedBody.data,
                authentication: readSessionAccessAuthenticationFromRequest(request),
            });
            if ("error" in result) {
                return reply.code(400).send({ error: "invalid-session-organization-order" });
            }
            return reply.send(result);
        }

        const result = await reorderSessionOrganization({
            accountId: request.userId,
            request: parsedBody.data,
            authentication: readSessionAccessAuthenticationFromRequest(request),
        });
        if ("error" in result) {
            return reply.code(400).send({ error: "invalid-session-organization-order" });
        }
        return reply.send(result);
    });

    app.post("/v2/session-organization/pins/reorder", {
        preHandler: app.authenticate,
        schema: {
            body: ReorderSessionOrganizationRequestSchema,
            response: {
                200: ReorderSessionOrganizationResponseSchema,
                400: z.object({ error: z.literal("invalid-session-organization-order") }),
            },
        },
    }, async (request, reply) => {
        const parsedBody = ReorderSessionOrganizationRequestSchema.safeParse(request.body);
        if (
            !parsedBody.success ||
            parsedBody.data.scopeKind !== "pinned" ||
            parsedBody.data.entries.some((entry) => entry.itemKind !== "session")
        ) {
            return reply.code(400).send({ error: "invalid-session-organization-order" });
        }

        const result = await reorderSessionPins({
            accountId: request.userId,
            request: parsedBody.data,
            authentication: readSessionAccessAuthenticationFromRequest(request),
        });
        if ("error" in result) {
            return reply.code(400).send({ error: "invalid-session-organization-order" });
        }

        return reply.send(result);
    });

    const folderRoutes = createServerFeatureGatedRouteApp(app, "sessions");

    folderRoutes.post("/v2/session-organization/folders", {
        preHandler: app.authenticate,
        schema: {
            body: CreateOrUpdateSessionOrganizationFolderRequestSchema,
            response: {
                200: CreateOrUpdateSessionOrganizationFolderResponseSchema,
                400: z.object({ error: z.literal("invalid-session-organization-folder") }),
                409: z.object({ error: z.literal("session-organization-folder-limit-exceeded") }),
            },
        },
    }, async (request, reply) => {
        const parsedBody = CreateOrUpdateSessionOrganizationFolderRequestSchema.safeParse(request.body);
        if (!parsedBody.success) {
            return reply.code(400).send({ error: "invalid-session-organization-folder" });
        }

        const result = await upsertSessionOrganizationFolder({
            accountId: request.userId,
            request: parsedBody.data,
        });
        if ("error" in result) {
            if (result.error === "session-organization-folder-limit-exceeded") {
                return reply.code(409).send({ error: result.error });
            }
            return reply.code(400).send({ error: "invalid-session-organization-folder" });
        }
        return reply.send(result);
    });

    folderRoutes.delete("/v2/session-organization/folders/:folderId", {
        preHandler: app.authenticate,
        schema: {
            params: folderIdParamsSchema,
            body: z.optional(DeleteSessionOrganizationFolderRequestSchema),
            response: {
                200: DeleteSessionOrganizationFolderResponseSchema,
                400: z.object({ error: z.literal("invalid-session-organization-folder-delete") }),
            },
        },
    }, async (request, reply) => {
        const parsedParams = folderIdParamsSchema.safeParse(request.params);
        if (!parsedParams.success) {
            return reply.code(400).send({ error: "invalid-session-organization-folder-delete" });
        }
        const body = request.body ?? { folderId: parsedParams.data.folderId };
        const parsedBody = DeleteSessionOrganizationFolderRequestSchema.safeParse(body);
        if (!parsedBody.success || parsedBody.data.folderId !== parsedParams.data.folderId) {
            return reply.code(400).send({ error: "invalid-session-organization-folder-delete" });
        }

        return reply.send(await deleteSessionOrganizationFolder({
            accountId: request.userId,
            request: parsedBody.data,
        }));
    });

    folderRoutes.put("/v2/session-organization/folder-assignments/:sessionId", {
        preHandler: app.authenticate,
        config: { apiTokenSessionAction: 'session.folder.set',
            restrictedCredentialBinding: { scope: 'session', session: 'params.sessionId', allowSessionRuntime: false } },
        schema: {
            params: sessionIdParamsSchema,
            body: SetSessionFolderAssignmentRequestSchema,
            response: {
                200: SetSessionFolderAssignmentResponseSchema,
                400: z.object({ error: z.literal("invalid-session-folder-assignment") }),
                404: z.object({ error: z.literal("Session not found") }),
            },
        },
    }, async (request, reply) => {
        const parsedParams = sessionIdParamsSchema.safeParse(request.params);
        const parsedBody = SetSessionFolderAssignmentRequestSchema.safeParse(request.body);
        if (!parsedParams.success || !parsedBody.success) {
            return reply.code(400).send({ error: "invalid-session-folder-assignment" });
        }

        const visible = await canAccessSyncedSessionForOrganization({
            accountId: request.userId,
            sessionId: parsedParams.data.sessionId,
            authentication: readSessionAccessAuthenticationFromRequest(request),
        });
        if (!visible) {
            return reply.code(404).send({ error: "Session not found" });
        }

        const result = await setSessionFolderAssignment({
            accountId: request.userId,
            sessionId: parsedParams.data.sessionId,
            folderId: parsedBody.data.folderId,
            authentication: readSessionAccessAuthenticationFromRequest(request),
        });
        if ("error" in result) {
            return reply.code(400).send({ error: "invalid-session-folder-assignment" });
        }
        return reply.send(result);
    });

    folderRoutes.post("/v2/session-organization/folder-assignments/move", {
        preHandler: app.authenticate,
        schema: {
            body: MoveSessionFolderAssignmentsRequestSchema,
            response: {
                200: MoveSessionFolderAssignmentsResponseSchema,
                400: z.object({ error: z.literal("invalid-session-folder-assignment-move") }),
            },
        },
    }, async (request, reply) => {
        const parsedBody = MoveSessionFolderAssignmentsRequestSchema.safeParse(request.body);
        if (!parsedBody.success) {
            return reply.code(400).send({ error: "invalid-session-folder-assignment-move" });
        }

        const result = await moveSessionFolderAssignments({
            accountId: request.userId,
            fromFolderIds: parsedBody.data.fromFolderIds,
            toFolderId: parsedBody.data.toFolderId,
            authentication: readSessionAccessAuthenticationFromRequest(request),
        });
        if ("error" in result) {
            return reply.code(400).send({ error: "invalid-session-folder-assignment-move" });
        }
        return reply.send(result);
    });

    app.post("/v2/session-organization/labels", {
        preHandler: app.authenticate,
        schema: {
            body: UpsertSessionOrganizationLabelRequestSchema,
            response: {
                200: UpsertSessionOrganizationLabelResponseSchema,
                400: z.object({ error: z.literal("invalid-session-organization-label") }),
                409: z.object({ error: z.literal("session-organization-label-limit-exceeded") }),
            },
        },
    }, async (request, reply) => {
        const parsedBody = UpsertSessionOrganizationLabelRequestSchema.safeParse(request.body);
        if (!parsedBody.success) {
            return reply.code(400).send({ error: "invalid-session-organization-label" });
        }

        const result = await upsertSessionOrganizationLabel({
            accountId: request.userId,
            request: parsedBody.data,
        });
        if ("error" in result) {
            if (result.error === "invalid-display-envelope") {
                return reply.code(400).send({ error: "invalid-session-organization-label" });
            }
            return reply.code(409).send({ error: result.error });
        }
        return reply.send(result);
    });

    app.delete("/v2/session-organization/labels", {
        preHandler: app.authenticate,
        schema: {
            body: DeleteSessionOrganizationLabelRequestSchema,
            response: {
                200: DeleteSessionOrganizationLabelResponseSchema,
                400: z.object({ error: z.literal("invalid-session-organization-label-delete") }),
            },
        },
    }, async (request, reply) => {
        const parsedBody = DeleteSessionOrganizationLabelRequestSchema.safeParse(request.body);
        if (!parsedBody.success) {
            return reply.code(400).send({ error: "invalid-session-organization-label-delete" });
        }

        return reply.send(await deleteSessionOrganizationLabel({
            accountId: request.userId,
            request: parsedBody.data,
        }));
    });

    app.post("/v2/session-organization/import", {
        preHandler: app.authenticate,
        schema: {
            body: ImportLegacySessionOrganizationRequestSchema,
            response: {
                200: ImportLegacySessionOrganizationResponseSchema,
                400: z.object({ error: z.literal("invalid-session-organization-import") }),
                409: z.object({
                    error: z.union([
                        z.literal("session-pin-limit-exceeded"),
                        z.literal("session-organization-folder-limit-exceeded"),
                        z.literal("session-organization-tag-limit-exceeded"),
                        z.literal("session-organization-label-limit-exceeded"),
                    ]),
                }),
            },
        },
    }, async (request, reply) => {
        const parsedBody = ImportLegacySessionOrganizationRequestSchema.safeParse(request.body);
        if (!parsedBody.success) {
            return reply.code(400).send({ error: "invalid-session-organization-import" });
        }

        const result = await importLegacySessionOrganization({
            accountId: request.userId,
            request: parsedBody.data,
            authentication: readSessionAccessAuthenticationFromRequest(request),
        });
        if ("error" in result) {
            if (result.error === "invalid-session-organization-import") {
                return reply.code(400).send({ error: result.error });
            }
            return reply.code(409).send({ error: result.error });
        }

        return reply.send(result);
    });

    app.post("/v2/session-organization/tags", {
        preHandler: app.authenticate,
        schema: {
            body: CreateOrUpdateSessionOrganizationTagRequestSchema,
            response: {
                200: CreateOrUpdateSessionOrganizationTagResponseSchema,
                400: z.object({ error: z.literal("invalid-session-organization-tag") }),
                409: z.object({ error: z.literal("session-organization-tag-limit-exceeded") }),
            },
        },
    }, async (request, reply) => {
        const parsedBody = CreateOrUpdateSessionOrganizationTagRequestSchema.safeParse(request.body);
        if (!parsedBody.success) {
            return reply.code(400).send({ error: "invalid-session-organization-tag" });
        }

        const result = await upsertSessionOrganizationTag({
            accountId: request.userId,
            request: parsedBody.data,
        });
        if ("error" in result) {
            if (result.error === "invalid-display-envelope") {
                return reply.code(400).send({ error: "invalid-session-organization-tag" });
            }
            return reply.code(409).send({ error: result.error });
        }
        return reply.send(result);
    });

    app.delete("/v2/session-organization/tags/:tagId", {
        preHandler: app.authenticate,
        schema: {
            params: tagIdParamsSchema,
            body: z.optional(DeleteSessionOrganizationTagRequestSchema),
            response: {
                200: DeleteSessionOrganizationTagResponseSchema,
                400: z.object({ error: z.literal("invalid-session-organization-tag-delete") }),
            },
        },
    }, async (request, reply) => {
        const parsedParams = tagIdParamsSchema.safeParse(request.params);
        if (!parsedParams.success) {
            return reply.code(400).send({ error: "invalid-session-organization-tag-delete" });
        }
        const body = request.body ?? { tagId: parsedParams.data.tagId };
        const parsedBody = DeleteSessionOrganizationTagRequestSchema.safeParse(body);
        if (!parsedBody.success || parsedBody.data.tagId !== parsedParams.data.tagId) {
            return reply.code(400).send({ error: "invalid-session-organization-tag-delete" });
        }

        return reply.send(await deleteSessionOrganizationTag({
            accountId: request.userId,
            request: parsedBody.data,
        }));
    });

    app.put("/v2/session-organization/tag-assignments/:sessionId", {
        preHandler: app.authenticate,
        config: { apiTokenSessionAction: 'session.tags.set',
            restrictedCredentialBinding: { scope: 'session', session: 'params.sessionId', allowSessionRuntime: false } },
        schema: {
            params: sessionIdParamsSchema,
            body: MutateSessionTagAssignmentsRequestSchema,
            response: {
                200: SetSessionTagAssignmentsResponseSchema,
                400: z.object({ error: z.literal("invalid-session-tag-assignments") }),
                404: z.object({ error: z.literal("Session not found") }),
            },
        },
    }, async (request, reply) => {
        const parsedParams = sessionIdParamsSchema.safeParse(request.params);
        const parsedBody = MutateSessionTagAssignmentsRequestSchema.safeParse(request.body);
        if (!parsedParams.success || !parsedBody.success) {
            return reply.code(400).send({ error: "invalid-session-tag-assignments" });
        }
        const visible = await canAccessSyncedSessionForOrganization({
            accountId: request.userId,
            sessionId: parsedParams.data.sessionId,
            authentication: readSessionAccessAuthenticationFromRequest(request),
        });
        if (!visible) {
            return reply.code(404).send({ error: "Session not found" });
        }

        const result = await setSessionTagAssignments({
            accountId: request.userId,
            sessionId: parsedParams.data.sessionId,
            request: parsedBody.data,
            authentication: readSessionAccessAuthenticationFromRequest(request),
        });
        if ("error" in result) {
            return reply.code(400).send({ error: "invalid-session-tag-assignments" });
        }
        return reply.send(result);
    });
}
