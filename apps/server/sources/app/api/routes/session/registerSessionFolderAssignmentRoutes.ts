import type { FeatureId } from "@happier-dev/protocol";
import {
    MoveSessionFolderAssignmentsRequestSchema,
    MoveSessionFolderAssignmentsResponseSchema,
    QuerySessionFolderSessionsRequestSchema,
    QuerySessionFolderSessionsResponseSchema,
    SessionFolderAssignmentListRequestSchema,
    SessionFolderAssignmentListResponseSchema,
    SetSessionFolderAssignmentRequestSchema,
    SetSessionFolderAssignmentResponseSchema,
} from "@happier-dev/protocol/sessionFolders";
import { z } from "zod";

import { createServerFeatureGatedRouteApp } from "@/app/features/catalog/serverFeatureGate";
import { canAccessSyncedSessionForFolderAssignment } from "@/app/session/folders/sessionFolderAssignmentAccess";
import {
    createSessionFolderAssignmentSessionWhere,
    fetchSessionFolderAssignmentsForSessions,
    moveSessionFolderAssignments,
    setSessionFolderAssignment,
} from "@/app/session/folders/sessionFolderAssignmentQueries";
import {
    createV2SessionListCursorWhere,
    createV2SessionListPage,
    findV2SessionListRows,
    resolveV2SessionListCursorForVisibleRows,
    V2_SESSION_LIST_ORDER_BY,
} from "./v2SessionListPage";
import { type Fastify } from "../../types";

const SESSION_FOLDERS_FEATURE_ID: FeatureId = "sessions.folders";

const assignmentListQuerySchema = z.object({
    sessionIds: z.string().min(1),
});

const setAssignmentParamsSchema = z.object({
    sessionId: z.string().min(1),
});

function parseDelimitedIds(value: string): string[] {
    const ids = value
        .split(",")
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
    return Array.from(new Set(ids));
}

export function registerSessionFolderAssignmentRoutes(app: Fastify) {
    const gated = createServerFeatureGatedRouteApp(app, SESSION_FOLDERS_FEATURE_ID);

    gated.get("/v2/session-folder-assignments", {
        preHandler: app.authenticate,
        schema: {
            querystring: assignmentListQuerySchema,
            response: {
                200: SessionFolderAssignmentListResponseSchema,
                400: z.object({ error: z.literal("invalid-session-ids") }),
            },
        },
    }, async (request, reply) => {
        const parsedQuery = assignmentListQuerySchema.safeParse(request.query);
        if (!parsedQuery.success) {
            return reply.code(400).send({ error: "invalid-session-ids" });
        }

        const parsedRequest = SessionFolderAssignmentListRequestSchema.safeParse({
            sessionIds: parseDelimitedIds(parsedQuery.data.sessionIds),
        });
        if (!parsedRequest.success) {
            return reply.code(400).send({ error: "invalid-session-ids" });
        }

        const assignments = await fetchSessionFolderAssignmentsForSessions({
            accountId: request.userId,
            sessionIds: parsedRequest.data.sessionIds,
        });

        return reply.send({ assignments });
    });

    gated.put("/v2/session-folder-assignments/:sessionId", {
        preHandler: app.authenticate,
        schema: {
            params: setAssignmentParamsSchema,
            body: SetSessionFolderAssignmentRequestSchema,
            response: {
                200: SetSessionFolderAssignmentResponseSchema,
                400: z.object({ error: z.literal("invalid-session-folder-assignment") }),
                404: z.object({ error: z.literal("Session not found") }),
            },
        },
    }, async (request, reply) => {
        const parsedParams = setAssignmentParamsSchema.safeParse(request.params);
        const parsedBody = SetSessionFolderAssignmentRequestSchema.safeParse(request.body);
        if (!parsedParams.success || !parsedBody.success) {
            return reply.code(400).send({ error: "invalid-session-folder-assignment" });
        }

        const accountId = request.userId;
        const { sessionId } = parsedParams.data;
        const visible = await canAccessSyncedSessionForFolderAssignment({ accountId, sessionId });
        if (!visible) {
            return reply.code(404).send({ error: "Session not found" });
        }

        const result = await setSessionFolderAssignment({
            accountId,
            sessionId,
            folderId: parsedBody.data.folderId,
        });

        return reply.send(result);
    });

    gated.post("/v2/session-folder-assignments/query", {
        preHandler: app.authenticate,
        schema: {
            body: QuerySessionFolderSessionsRequestSchema,
            response: {
                200: QuerySessionFolderSessionsResponseSchema,
                400: z.object({ error: z.literal("invalid-folder-session-query") }),
            },
        },
    }, async (request, reply) => {
        const parsedBody = QuerySessionFolderSessionsRequestSchema.safeParse(request.body);
        if (!parsedBody.success) {
            return reply.code(400).send({ error: "invalid-folder-session-query" });
        }

        const archived = parsedBody.data.archived ?? false;
        const cursorRowWhere = createSessionFolderAssignmentSessionWhere({
            accountId: request.userId,
            folderIds: parsedBody.data.folderIds,
            archived,
        });
        const decodedCursor = await resolveV2SessionListCursorForVisibleRows({
            cursor: parsedBody.data.cursor,
            userId: request.userId,
            cursorRowWhere,
        });
        if (decodedCursor === null) {
            return reply.code(400).send({ error: "invalid-folder-session-query" });
        }

        const rows = await findV2SessionListRows({
            userId: request.userId,
            where: createSessionFolderAssignmentSessionWhere({
                accountId: request.userId,
                folderIds: parsedBody.data.folderIds,
                archived,
                cursorWhere: createV2SessionListCursorWhere(decodedCursor),
            }),
            orderBy: V2_SESSION_LIST_ORDER_BY,
            take: (parsedBody.data.limit ?? 50) + 1,
        });

        return reply.send(createV2SessionListPage({
            rows,
            userId: request.userId,
            limit: parsedBody.data.limit ?? 50,
        }));
    });

    gated.post("/v2/session-folder-assignments/move", {
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

        return reply.send(result);
    });
}
