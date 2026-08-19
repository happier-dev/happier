import type { FeatureId } from "@happier-dev/protocol";
import {
    CreateOrUpdateSessionOrganizationFolderRequestSchema,
    CreateOrUpdateSessionOrganizationFolderResponseSchema,
    CreateOrUpdateSessionOrganizationTagRequestSchema,
    CreateOrUpdateSessionOrganizationTagResponseSchema,
    DeleteSessionOrganizationLabelRequestSchema,
    DeleteSessionOrganizationLabelResponseSchema,
    DeleteSessionOrganizationFolderRequestSchema,
    DeleteSessionOrganizationFolderResponseSchema,
    DeleteSessionOrganizationTagRequestSchema,
    DeleteSessionOrganizationTagResponseSchema,
    ImportLegacySessionOrganizationRequestSchema,
    ImportLegacySessionOrganizationResponseSchema,
    MoveSessionFolderAssignmentsRequestSchema,
    MoveSessionFolderAssignmentsResponseSchema,
    ReorderSessionOrganizationRequestSchema,
    ReorderSessionOrganizationResponseSchema,
    SessionOrganizationSnapshotRequestSchema,
    SessionOrganizationSnapshotResponseSchema,
    SetSessionAttentionStandingRequestSchema,
    SetSessionAttentionStandingResponseSchema,
    SetSessionFolderAssignmentRequestSchema,
    SetSessionFolderAssignmentResponseSchema,
    SetSessionPinRequestSchema,
    SetSessionPinResponseSchema,
    SetSessionTagAssignmentsRequestSchema,
    SetSessionTagAssignmentsResponseSchema,
    UpsertSessionOrganizationLabelRequestSchema,
    UpsertSessionOrganizationLabelResponseSchema,
} from "@happier-dev/protocol";
import { z } from "zod";

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
    setSessionFolderAssignment,
    setSessionPin,
    setSessionTagAssignments,
    upsertSessionOrganizationLabel,
    upsertSessionOrganizationTag,
    upsertSessionOrganizationFolder,
} from "@/app/session/organization/organizationMutations";
import { fetchSessionOrganizationSnapshot } from "@/app/session/organization/organizationQueries";
import { reorderSessionOrganization, reorderSessionPins } from "@/app/session/organization/organizationOrdering";
import { type Fastify } from "../../types";

const SESSION_FOLDERS_FEATURE_ID: FeatureId = "sessions.folders";

const sessionIdParamsSchema = z.object({
    sessionId: z.string().min(1),
});

const folderIdParamsSchema = z.object({
    folderId: z.string().min(1),
});

const tagIdParamsSchema = z.object({
    tagId: z.string().min(1),
});

const invalidQueryValue = Symbol("invalid-session-organization-query-value");

type ParsedQueryValue<T> = T | undefined | typeof invalidQueryValue;

function parseOptionalBoolean(value: unknown): ParsedQueryValue<boolean> {
    if (value === undefined) return undefined;
    if (value === true || value === "true" || value === "1") return true;
    if (value === false || value === "false" || value === "0") return false;
    return invalidQueryValue;
}

function parseDelimitedQueryList(value: unknown): string[] | undefined {
    if (typeof value !== "string") return undefined;
    const values = value
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
    return values.length > 0 ? Array.from(new Set(values)) : undefined;
}

function parseOrderScopesQuery(value: unknown): unknown[] | undefined {
    if (typeof value !== "string") return undefined;
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : [{}];
    } catch {
        return [{}];
    }
}

function addOptionalBooleanQueryField(
    target: Record<string, unknown>,
    key: string,
    value: unknown,
): boolean {
    const parsed = parseOptionalBoolean(value);
    if (parsed === invalidQueryValue) return false;
    if (parsed !== undefined) target[key] = parsed;
    return true;
}

function buildSnapshotRequestFromQuery(query: unknown): unknown {
    const record = query && typeof query === "object" ? query as Record<string, unknown> : {};
    const orderScopes = parseOrderScopesQuery(record.orderScopes);
    const request: Record<string, unknown> = {};
    for (const key of [
        "includeFolders",
        "includeTags",
        "includeLabels",
        "includeAllFolderAssignments",
        "includeAllTagAssignments",
        "includeAttentionStandings",
    ]) {
        if (!addOptionalBooleanQueryField(request, key, record[key])) return { [key]: invalidQueryValue };
    }
    const assignmentSessionIds = parseDelimitedQueryList(record.assignmentSessionIds);
    if (assignmentSessionIds) request.assignmentSessionIds = assignmentSessionIds;
    const folderIds = parseDelimitedQueryList(record.folderIds);
    if (folderIds) request.folderIds = folderIds;
    const tagIds = parseDelimitedQueryList(record.tagIds);
    if (tagIds) request.tagIds = tagIds;
    if (orderScopes) request.orderScopes = orderScopes;
    return request;
}

export function registerSessionOrganizationRoutes(app: Fastify) {
    app.get("/v2/session-organization", {
        preHandler: app.authenticate,
        schema: {
            response: {
                200: SessionOrganizationSnapshotResponseSchema,
                400: z.object({ error: z.literal("invalid-session-organization-snapshot-request") }),
            },
        },
    }, async (request, reply) => {
        const parsedRequest = SessionOrganizationSnapshotRequestSchema.safeParse(buildSnapshotRequestFromQuery(request.query));
        if (!parsedRequest.success) {
            return reply.code(400).send({ error: "invalid-session-organization-snapshot-request" });
        }

        const snapshot = await fetchSessionOrganizationSnapshot({
            accountId: request.userId,
            request: parsedRequest.data,
        });

        return reply.send({ snapshot });
    });

    app.put("/v2/session-organization/pins/:sessionId", {
        preHandler: app.authenticate,
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
            })
            : await canAccessSyncedSessionForOrganization({
                accountId: request.userId,
                sessionId: parsedParams.data.sessionId,
            });
        if (!visible) {
            return reply.code(404).send({ error: "Session not found" });
        }

        const result = await setSessionPin({
            accountId: request.userId,
            sessionId: parsedParams.data.sessionId,
            request: parsedBody.data,
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

        const visible = parsedBody.data.standing === null
            ? await canAccessSyncedSessionForOrganization({
                accountId: request.userId,
                sessionId: parsedParams.data.sessionId,
            })
            : await canAccessVisibleUnarchivedSessionForOrganization({
                accountId: request.userId,
                sessionId: parsedParams.data.sessionId,
            });
        if (!visible) {
            return reply.code(404).send({ error: "Session not found" });
        }

        const result = await setSessionAttentionStanding({
            accountId: request.userId,
            sessionId: parsedParams.data.sessionId,
            request: parsedBody.data,
        });
        if ("error" in result) {
            return reply.code(404).send({ error: "Session not found" });
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
                409: z.object({ error: z.literal("session-pin-limit-exceeded") }),
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
            });
            if ("error" in result) {
                if (result.error === "session-pin-limit-exceeded") {
                    return reply.code(409).send({ error: result.error });
                }
                return reply.code(400).send({ error: "invalid-session-organization-order" });
            }
            return reply.send(result);
        }

        const result = await reorderSessionOrganization({
            accountId: request.userId,
            request: parsedBody.data,
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
                409: z.object({ error: z.literal("session-pin-limit-exceeded") }),
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
        });
        if ("error" in result) {
            if (result.error === "session-pin-limit-exceeded") {
                return reply.code(409).send({ error: result.error });
            }
            return reply.code(400).send({ error: "invalid-session-organization-order" });
        }

        return reply.send(result);
    });

    const folderRoutes = createServerFeatureGatedRouteApp(app, SESSION_FOLDERS_FEATURE_ID);

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
            body: DeleteSessionOrganizationFolderRequestSchema.optional(),
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
        });
        if (!visible) {
            return reply.code(404).send({ error: "Session not found" });
        }

        const result = await setSessionFolderAssignment({
            accountId: request.userId,
            sessionId: parsedParams.data.sessionId,
            folderId: parsedBody.data.folderId,
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
            body: DeleteSessionOrganizationTagRequestSchema.optional(),
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
        schema: {
            params: sessionIdParamsSchema,
            body: SetSessionTagAssignmentsRequestSchema,
            response: {
                200: SetSessionTagAssignmentsResponseSchema,
                400: z.object({ error: z.literal("invalid-session-tag-assignments") }),
                404: z.object({ error: z.literal("Session not found") }),
            },
        },
    }, async (request, reply) => {
        const parsedParams = sessionIdParamsSchema.safeParse(request.params);
        const parsedBody = SetSessionTagAssignmentsRequestSchema.safeParse(request.body);
        if (!parsedParams.success || !parsedBody.success) {
            return reply.code(400).send({ error: "invalid-session-tag-assignments" });
        }
        const visible = await canAccessSyncedSessionForOrganization({
            accountId: request.userId,
            sessionId: parsedParams.data.sessionId,
        });
        if (!visible) {
            return reply.code(404).send({ error: "Session not found" });
        }

        const result = await setSessionTagAssignments({
            accountId: request.userId,
            sessionId: parsedParams.data.sessionId,
            request: parsedBody.data,
        });
        if ("error" in result) {
            return reply.code(400).send({ error: "invalid-session-tag-assignments" });
        }
        return reply.send(result);
    });
}
