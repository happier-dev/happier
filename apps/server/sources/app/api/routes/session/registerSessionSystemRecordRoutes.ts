import { z } from "zod";

import {
    getLatestSessionSystemRecord,
    getSessionSystemRecord,
    listSessionSystemRecords,
    upsertSessionSystemRecord,
} from "@/app/session/systemRecords/sessionSystemRecordService";
import { toPublicSessionSystemRecord } from "@/app/session/systemRecords/sessionSystemRecordSerialization";
import {
    SessionSystemRecordLatestQuerySchema,
    SessionSystemRecordLatestResponseSchema,
    SessionSystemRecordListQuerySchema,
    SessionSystemRecordLookupQuerySchema,
    SessionSystemRecordLookupResponseSchema,
    SessionSystemRecordPageResponseSchema,
    SessionSystemRecordUpsertRequestSchema,
    SessionSystemRecordUpsertResponseSchema,
} from "@happier-dev/protocol";
import { type Fastify } from "../../types";

export function registerSessionSystemRecordRoutes(app: Fastify) {
    app.get("/v2/sessions/:sessionId/system-records", {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ sessionId: z.string() }),
            querystring: SessionSystemRecordListQuerySchema.optional(),
            response: {
                200: SessionSystemRecordPageResponseSchema,
                400: z.object({ error: z.literal("Invalid parameters") }),
                403: z.object({ error: z.literal("Forbidden") }),
                404: z.object({ error: z.literal("Session not found") }),
                500: z.object({ error: z.literal("Failed to list system records") }),
            },
        },
    }, async (request, reply) => {
        const parsedQuery = SessionSystemRecordListQuerySchema.safeParse(request.query ?? {});
        if (!parsedQuery.success) return reply.code(400).send({ error: "Invalid parameters" });
        const query = parsedQuery.data;
        const result = await listSessionSystemRecords({
            actorUserId: request.userId,
            sessionId: request.params.sessionId,
            namespace: query.namespace,
            kind: query.kind,
            localId: query.localId,
            limit: query.limit,
            cursor: query.cursor ?? undefined,
        });

        if (!result.ok) {
            if (result.error === "invalid-params") return reply.code(400).send({ error: "Invalid parameters" });
            if (result.error === "forbidden") return reply.code(403).send({ error: "Forbidden" });
            if (result.error === "session-not-found") return reply.code(404).send({ error: "Session not found" });
            return reply.code(500).send({ error: "Failed to list system records" });
        }

        return reply.send({
            records: result.records.map(toPublicSessionSystemRecord),
            nextCursor: result.nextCursor,
            hasNext: result.nextCursor !== null,
        });
    });

    app.get("/v2/sessions/:sessionId/system-records/record", {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ sessionId: z.string() }),
            querystring: SessionSystemRecordLookupQuerySchema,
            response: {
                200: SessionSystemRecordLookupResponseSchema,
                400: z.object({ error: z.literal("Invalid parameters") }),
                403: z.object({ error: z.literal("Forbidden") }),
                404: z.object({ error: z.literal("Session not found") }),
                500: z.object({ error: z.literal("Failed to fetch system record") }),
            },
        },
    }, async (request, reply) => {
        const parsedQuery = SessionSystemRecordLookupQuerySchema.safeParse(request.query);
        if (!parsedQuery.success) return reply.code(400).send({ error: "Invalid parameters" });
        const result = await getSessionSystemRecord({
            actorUserId: request.userId,
            sessionId: request.params.sessionId,
            namespace: parsedQuery.data.namespace,
            localId: parsedQuery.data.localId,
        });

        if (!result.ok) {
            if (result.error === "invalid-params") return reply.code(400).send({ error: "Invalid parameters" });
            if (result.error === "forbidden") return reply.code(403).send({ error: "Forbidden" });
            if (result.error === "session-not-found") return reply.code(404).send({ error: "Session not found" });
            return reply.code(500).send({ error: "Failed to fetch system record" });
        }

        return reply.send({ record: result.record ? toPublicSessionSystemRecord(result.record) : null });
    });

    app.get("/v2/sessions/:sessionId/system-records/latest", {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ sessionId: z.string() }),
            querystring: SessionSystemRecordLatestQuerySchema,
            response: {
                200: SessionSystemRecordLatestResponseSchema,
                400: z.object({ error: z.literal("Invalid parameters") }),
                403: z.object({ error: z.literal("Forbidden") }),
                404: z.object({ error: z.literal("Session not found") }),
                500: z.object({ error: z.literal("Failed to fetch latest system record") }),
            },
        },
    }, async (request, reply) => {
        const parsedQuery = SessionSystemRecordLatestQuerySchema.safeParse(request.query);
        if (!parsedQuery.success) return reply.code(400).send({ error: "Invalid parameters" });
        const result = await getLatestSessionSystemRecord({
            actorUserId: request.userId,
            sessionId: request.params.sessionId,
            namespace: parsedQuery.data.namespace,
            kind: parsedQuery.data.kind,
        });

        if (!result.ok) {
            if (result.error === "invalid-params") return reply.code(400).send({ error: "Invalid parameters" });
            if (result.error === "forbidden") return reply.code(403).send({ error: "Forbidden" });
            if (result.error === "session-not-found") return reply.code(404).send({ error: "Session not found" });
            return reply.code(500).send({ error: "Failed to fetch latest system record" });
        }

        return reply.send({ record: result.record ? toPublicSessionSystemRecord(result.record) : null });
    });

    app.put("/v2/sessions/:sessionId/system-records", {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ sessionId: z.string() }),
            body: SessionSystemRecordUpsertRequestSchema,
            response: {
                200: SessionSystemRecordUpsertResponseSchema,
                400: z.object({ error: z.literal("Invalid parameters"), code: z.string().optional() }).passthrough(),
                403: z.object({ error: z.literal("Forbidden") }),
                404: z.object({ error: z.literal("Session not found") }),
                409: z.object({ error: z.literal("Conflict"), code: z.string() }).passthrough(),
                500: z.object({ error: z.literal("Failed to upsert system record") }),
            },
        },
    }, async (request, reply) => {
        const parsedBody = SessionSystemRecordUpsertRequestSchema.safeParse(request.body);
        if (!parsedBody.success) return reply.code(400).send({ error: "Invalid parameters" });
        const body = parsedBody.data;
        const result = await upsertSessionSystemRecord({
            actorUserId: request.userId,
            sessionId: request.params.sessionId,
            namespace: body.namespace,
            kind: body.kind,
            localId: body.localId,
            content: body.content,
        });

        if (!result.ok) {
            if (result.error === "invalid-params") {
                const payload: { error: "Invalid parameters"; code?: string } = { error: "Invalid parameters" };
                if (typeof result.code === "string") payload.code = result.code;
                return reply.code(400).send(payload);
            }
            if (result.error === "forbidden") return reply.code(403).send({ error: "Forbidden" });
            if (result.error === "session-not-found") return reply.code(404).send({ error: "Session not found" });
            if (result.error === "conflict") return reply.code(409).send({ error: "Conflict", code: "system_record_kind_conflict" });
            return reply.code(500).send({ error: "Failed to upsert system record" });
        }

        return reply.send({
            didCreate: result.didCreate,
            didUpdate: result.didUpdate,
            record: toPublicSessionSystemRecord(result.record),
        });
    });
}
