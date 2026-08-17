import { z } from "zod";
import type { FastifyReply } from "fastify";

import {
    getLatestSessionSystemRecord,
    getSessionSystemRecord,
    deleteSessionSystemRecordV1,
    listPermissionMediationRecords,
    prunePermissionMediationRecord,
    listSessionSystemRecords,
    listSessionSystemRecordsV1,
    readSessionSystemRecordV1,
    readPermissionMediationRecord,
    upsertSessionSystemRecord,
    upsertSessionSystemRecordV1,
    writePermissionMediationRecord,
} from "@/app/session/systemRecords/sessionSystemRecordService";
import { isSessionSystemRecordsProtocolV1Active } from "@/app/session/systemRecords/sessionSystemRecordProtocolContract";
import { toPublicSessionSystemRecord } from "@/app/session/systemRecords/sessionSystemRecordSerialization";
import {
    LegacyHostSessionSystemRecordLatestQuerySchema,
    LegacyHostSessionSystemRecordLatestResponseSchema,
    LegacyHostSessionSystemRecordListQuerySchema,
    LegacyHostSessionSystemRecordLookupQuerySchema,
    LegacyHostSessionSystemRecordLookupResponseSchema,
    LegacyHostSessionSystemRecordPageResponseSchema,
    LegacyHostSessionSystemRecordUpsertRequestSchema,
    LegacyHostSessionSystemRecordUpsertResponseSchema,
    PluginIdSchema,
    SESSION_SYSTEM_RECORDS_PLUGIN_ID_HEADER,
    SessionSystemRecordAddressSchema,
    SessionSystemRecordDeleteRequestSchema,
    SessionSystemRecordDeleteResponseSchema,
    SessionSystemRecordListQuerySchema,
    SessionSystemRecordStoredPageResponseSchema,
    SessionSystemRecordStoredReadResponseSchema,
    SessionSystemRecordStoredUpsertRequestSchema,
    SessionSystemRecordStoredUpsertResponseSchema,
    SessionPermissionMediationRecordListQuerySchema,
    SessionPermissionMediationRecordListResponseSchema,
    SessionPermissionMediationRecordIdentityV1Schema,
    SessionPermissionMediationRecordReadResponseSchema,
    SessionPermissionMediationRecordPruneRequestSchema,
    SessionPermissionMediationRecordPruneResponseSchema,
    SessionPermissionMediationRecordWriteRequestSchema,
    SessionPermissionMediationRecordWriteResponseSchema,
} from "@happier-dev/protocol";
import { type Fastify } from "../../types";

const PLUGIN_RECORD_ERROR_RESPONSE_SCHEMA = z.object({
    error: z.string(),
    code: z.string(),
    currentRevision: z.string().optional(),
}).strict();

const PERMISSION_MEDIATION_RECORD_ERROR_RESPONSE_SCHEMA = z.object({
    error: z.string(),
    code: z.string(),
    currentRevision: z.string().optional(),
}).strict();

const PERMISSION_MEDIATION_RECORD_ROUTE_PARAMS_SCHEMA = SessionPermissionMediationRecordIdentityV1Schema;
const PERMISSION_MEDIATION_RECORD_LIST_ROUTE_PARAMS_SCHEMA = SessionPermissionMediationRecordIdentityV1Schema.pick({
    sessionId: true,
});

function isSystemRecordV1Request(request: Readonly<{ headers: Record<string, unknown> }>): boolean {
    return request.headers["x-happier-session-system-records-protocol"] === "1";
}

function readSystemRecordV1PluginId(request: Readonly<{ headers: Record<string, unknown> }>): string | null {
    const rawPluginId = request.headers[SESSION_SYSTEM_RECORDS_PLUGIN_ID_HEADER];
    if (typeof rawPluginId !== "string") return null;
    const parsedPluginId = PluginIdSchema.safeParse(rawPluginId);
    return parsedPluginId.success ? parsedPluginId.data : null;
}

function hasUnmistakableSystemRecordV1GetIntent(query: unknown): boolean {
    if (!query || typeof query !== "object" || Array.isArray(query)) return false;
    return Object.prototype.hasOwnProperty.call(query, "owner")
        || Object.prototype.hasOwnProperty.call(query, "address");
}

function sendPluginRecordError(
    reply: FastifyReply,
    result: Readonly<{ code: string; currentRevision?: string }>,
): FastifyReply {
    const payload = {
        error: "Plugin Session system record operation failed",
        code: result.code,
        ...(result.currentRevision ? { currentRevision: result.currentRevision } : {}),
    };
    if (result.code === "plugin_session_records_unavailable") return reply.code(503).send(payload);
    if (result.code === "plugin_session_record_invalid_query") return reply.code(400).send(payload);
    if (result.code === "plugin_session_record_forbidden") return reply.code(403).send(payload);
    if (result.code === "plugin_session_not_found") return reply.code(404).send(payload);
    if (
        result.code === "plugin_session_record_address_collision"
        || result.code === "plugin_session_record_kind_conflict"
        || result.code === "plugin_session_record_revision_conflict"
        || result.code === "plugin_session_record_revision_exhausted"
    ) return reply.code(409).send(payload);
    return reply.code(500).send(payload);
}

function sendPermissionMediationRecordError(
    reply: FastifyReply,
    result: Readonly<{ code: string; currentRevision?: string }>,
): FastifyReply {
    const payload = {
        error: "Permission mediation record operation failed",
        code: result.code,
        ...(result.currentRevision ? { currentRevision: result.currentRevision } : {}),
    };
    if (result.code === "permission_mediation_records_unavailable") return reply.code(503).send(payload);
    if (result.code === "permission_mediation_record_invalid") return reply.code(400).send(payload);
    if (result.code === "permission_mediation_record_forbidden") return reply.code(403).send(payload);
    if (result.code === "permission_mediation_session_not_found") return reply.code(404).send(payload);
    if (result.code === "permission_mediation_record_conflict") return reply.code(409).send(payload);
    return reply.code(500).send(payload);
}

export function registerSessionSystemRecordRoutes(app: Fastify) {
    const withPluginRecordError = <T extends z.ZodTypeAny>(legacy: T) => (
        z.union([legacy, PLUGIN_RECORD_ERROR_RESPONSE_SCHEMA])
    );

    // This is a narrow host-owned transport, not a generic System Records
    // endpoint.  It intentionally receives no plugin id or namespace from the
    // request, because a bearer-authenticated HTTP caller cannot attest a
    // plugin namespace.
    app.get("/v2/sessions/:sessionId/permission-mediation-records", {
        preHandler: app.authenticate,
        schema: {
            params: PERMISSION_MEDIATION_RECORD_LIST_ROUTE_PARAMS_SCHEMA,
            querystring: SessionPermissionMediationRecordListQuerySchema,
            response: {
                200: SessionPermissionMediationRecordListResponseSchema,
                400: PERMISSION_MEDIATION_RECORD_ERROR_RESPONSE_SCHEMA,
                403: PERMISSION_MEDIATION_RECORD_ERROR_RESPONSE_SCHEMA,
                404: PERMISSION_MEDIATION_RECORD_ERROR_RESPONSE_SCHEMA,
                500: PERMISSION_MEDIATION_RECORD_ERROR_RESPONSE_SCHEMA,
                503: PERMISSION_MEDIATION_RECORD_ERROR_RESPONSE_SCHEMA,
            },
        },
    }, async (request, reply) => {
        const result = await listPermissionMediationRecords({
            actorUserId: request.userId,
            sessionId: request.params.sessionId,
            query: request.query,
        });
        if (!result.ok) return sendPermissionMediationRecordError(reply, result);
        return reply.send({
            ...result.page,
            records: [...result.page.records],
        });
    });

    app.get("/v2/sessions/:sessionId/permission-mediation-records/:turnId/:requestId", {
        preHandler: app.authenticate,
        schema: {
            params: PERMISSION_MEDIATION_RECORD_ROUTE_PARAMS_SCHEMA,
            response: {
                200: SessionPermissionMediationRecordReadResponseSchema,
                400: PERMISSION_MEDIATION_RECORD_ERROR_RESPONSE_SCHEMA,
                403: PERMISSION_MEDIATION_RECORD_ERROR_RESPONSE_SCHEMA,
                404: PERMISSION_MEDIATION_RECORD_ERROR_RESPONSE_SCHEMA,
                500: PERMISSION_MEDIATION_RECORD_ERROR_RESPONSE_SCHEMA,
                503: PERMISSION_MEDIATION_RECORD_ERROR_RESPONSE_SCHEMA,
            },
        },
    }, async (request, reply) => {
        const result = await readPermissionMediationRecord({
            actorUserId: request.userId,
            sessionId: request.params.sessionId,
            identity: request.params,
        });
        if (!result.ok) return sendPermissionMediationRecordError(reply, result);
        return reply.send({ record: result.record });
    });

    app.put("/v2/sessions/:sessionId/permission-mediation-records/:turnId/:requestId", {
        preHandler: app.authenticate,
        schema: {
            params: PERMISSION_MEDIATION_RECORD_ROUTE_PARAMS_SCHEMA,
            body: SessionPermissionMediationRecordWriteRequestSchema,
            response: {
                200: SessionPermissionMediationRecordWriteResponseSchema,
                400: PERMISSION_MEDIATION_RECORD_ERROR_RESPONSE_SCHEMA,
                403: PERMISSION_MEDIATION_RECORD_ERROR_RESPONSE_SCHEMA,
                404: PERMISSION_MEDIATION_RECORD_ERROR_RESPONSE_SCHEMA,
                409: PERMISSION_MEDIATION_RECORD_ERROR_RESPONSE_SCHEMA,
                500: PERMISSION_MEDIATION_RECORD_ERROR_RESPONSE_SCHEMA,
                503: PERMISSION_MEDIATION_RECORD_ERROR_RESPONSE_SCHEMA,
            },
        },
    }, async (request, reply) => {
        const result = await writePermissionMediationRecord({
            actorUserId: request.userId,
            sessionId: request.params.sessionId,
            identity: request.params,
            request: request.body,
        });
        if (!result.ok) return sendPermissionMediationRecordError(reply, result);
        return reply.send({ record: result.record });
    });

    // Retention is the only typed deletion operation. The Permission owner
    // first opens an encrypted row, proves it inactive, then supplies the
    // exact revision; this endpoint never exposes generic host CRUD.
    app.delete("/v2/sessions/:sessionId/permission-mediation-records/:turnId/:requestId", {
        preHandler: app.authenticate,
        schema: {
            params: PERMISSION_MEDIATION_RECORD_ROUTE_PARAMS_SCHEMA,
            body: SessionPermissionMediationRecordPruneRequestSchema,
            response: {
                200: SessionPermissionMediationRecordPruneResponseSchema,
                400: PERMISSION_MEDIATION_RECORD_ERROR_RESPONSE_SCHEMA,
                403: PERMISSION_MEDIATION_RECORD_ERROR_RESPONSE_SCHEMA,
                404: PERMISSION_MEDIATION_RECORD_ERROR_RESPONSE_SCHEMA,
                409: PERMISSION_MEDIATION_RECORD_ERROR_RESPONSE_SCHEMA,
                500: PERMISSION_MEDIATION_RECORD_ERROR_RESPONSE_SCHEMA,
                503: PERMISSION_MEDIATION_RECORD_ERROR_RESPONSE_SCHEMA,
            },
        },
    }, async (request, reply) => {
        const result = await prunePermissionMediationRecord({
            actorUserId: request.userId,
            sessionId: request.params.sessionId,
            identity: request.params,
            request: request.body,
        });
        if (!result.ok) return sendPermissionMediationRecordError(reply, result);
        return reply.send({ ok: true });
    });

    app.get("/v2/sessions/:sessionId/system-records", {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ sessionId: z.string() }),
            querystring: z.union([
                SessionSystemRecordListQuerySchema,
                LegacyHostSessionSystemRecordListQuerySchema,
            ]).optional(),
            response: {
                200: z.union([SessionSystemRecordStoredPageResponseSchema, LegacyHostSessionSystemRecordPageResponseSchema]),
                400: withPluginRecordError(z.object({ error: z.literal("Invalid parameters") })),
                403: withPluginRecordError(z.object({ error: z.literal("Forbidden") })),
                404: withPluginRecordError(z.object({ error: z.literal("Session not found") })),
                409: PLUGIN_RECORD_ERROR_RESPONSE_SCHEMA,
                503: PLUGIN_RECORD_ERROR_RESPONSE_SCHEMA,
                500: withPluginRecordError(z.object({ error: z.literal("Failed to list system records") })),
            },
        },
    }, async (request, reply) => {
        if (isSystemRecordV1Request(request)) {
            if (!isSessionSystemRecordsProtocolV1Active()) {
                return sendPluginRecordError(reply, { code: "plugin_session_records_unavailable" });
            }
            const pluginId = readSystemRecordV1PluginId(request);
            if (!pluginId) return sendPluginRecordError(reply, { code: "plugin_session_record_invalid_query" });
            const parsedQuery = SessionSystemRecordListQuerySchema.safeParse(request.query ?? {});
            if (!parsedQuery.success) return sendPluginRecordError(reply, { code: "plugin_session_record_invalid_query" });
            const result = await listSessionSystemRecordsV1({
                actorUserId: request.userId,
                sessionId: request.params.sessionId,
                pluginId,
                query: parsedQuery.data,
            });
            if (!result.ok) return sendPluginRecordError(reply, result);
            return reply.send({
                ...result.page,
                records: [...result.page.records],
            });
        }
        if (hasUnmistakableSystemRecordV1GetIntent(request.query)) {
            return reply.code(400).send({ error: "Invalid parameters" });
        }
        const parsedQuery = LegacyHostSessionSystemRecordListQuerySchema.safeParse(request.query ?? {});
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
            querystring: z.union([SessionSystemRecordAddressSchema, LegacyHostSessionSystemRecordLookupQuerySchema]),
            response: {
                200: z.union([SessionSystemRecordStoredReadResponseSchema, LegacyHostSessionSystemRecordLookupResponseSchema]),
                400: withPluginRecordError(z.object({ error: z.literal("Invalid parameters") })),
                403: withPluginRecordError(z.object({ error: z.literal("Forbidden") })),
                404: withPluginRecordError(z.object({ error: z.literal("Session not found") })),
                409: PLUGIN_RECORD_ERROR_RESPONSE_SCHEMA,
                503: PLUGIN_RECORD_ERROR_RESPONSE_SCHEMA,
                500: withPluginRecordError(z.object({ error: z.literal("Failed to fetch system record") })),
            },
        },
    }, async (request, reply) => {
        if (isSystemRecordV1Request(request)) {
            if (!isSessionSystemRecordsProtocolV1Active()) {
                return sendPluginRecordError(reply, { code: "plugin_session_records_unavailable" });
            }
            const pluginId = readSystemRecordV1PluginId(request);
            if (!pluginId) return sendPluginRecordError(reply, { code: "plugin_session_record_invalid_query" });
            const parsedAddress = SessionSystemRecordAddressSchema.safeParse(request.query);
            if (!parsedAddress.success) return sendPluginRecordError(reply, { code: "plugin_session_record_invalid_query" });
            const result = await readSessionSystemRecordV1({
                actorUserId: request.userId,
                sessionId: request.params.sessionId,
                pluginId,
                address: parsedAddress.data,
            });
            if (!result.ok) return sendPluginRecordError(reply, result);
            return reply.send({ record: result.record });
        }
        if (hasUnmistakableSystemRecordV1GetIntent(request.query)) {
            return reply.code(400).send({ error: "Invalid parameters" });
        }
        const parsedQuery = LegacyHostSessionSystemRecordLookupQuerySchema.safeParse(request.query);
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
            querystring: LegacyHostSessionSystemRecordLatestQuerySchema,
            response: {
                200: LegacyHostSessionSystemRecordLatestResponseSchema,
                400: z.object({ error: z.literal("Invalid parameters") }),
                403: z.object({ error: z.literal("Forbidden") }),
                404: z.object({ error: z.literal("Session not found") }),
                500: z.object({ error: z.literal("Failed to fetch latest system record") }),
            },
        },
    }, async (request, reply) => {
        const parsedQuery = LegacyHostSessionSystemRecordLatestQuerySchema.safeParse(request.query);
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
            body: z.union([SessionSystemRecordStoredUpsertRequestSchema, LegacyHostSessionSystemRecordUpsertRequestSchema]),
            response: {
                200: z.union([SessionSystemRecordStoredUpsertResponseSchema, LegacyHostSessionSystemRecordUpsertResponseSchema]),
                400: withPluginRecordError(z.object({ error: z.literal("Invalid parameters"), code: z.string().optional() }).passthrough()),
                403: withPluginRecordError(z.object({ error: z.literal("Forbidden") })),
                404: withPluginRecordError(z.object({ error: z.literal("Session not found") })),
                409: withPluginRecordError(z.object({ error: z.literal("Conflict"), code: z.string() }).passthrough()),
                503: PLUGIN_RECORD_ERROR_RESPONSE_SCHEMA,
                500: withPluginRecordError(z.object({ error: z.literal("Failed to upsert system record") })),
            },
        },
    }, async (request, reply) => {
        if (isSystemRecordV1Request(request)) {
            if (!isSessionSystemRecordsProtocolV1Active()) {
                return sendPluginRecordError(reply, { code: "plugin_session_records_unavailable" });
            }
            const pluginId = readSystemRecordV1PluginId(request);
            if (!pluginId) return sendPluginRecordError(reply, { code: "plugin_session_record_invalid_query" });
            const parsedBody = SessionSystemRecordStoredUpsertRequestSchema.safeParse(request.body);
            if (!parsedBody.success) return sendPluginRecordError(reply, { code: "plugin_session_record_invalid_query" });
            const result = await upsertSessionSystemRecordV1({
                actorUserId: request.userId,
                sessionId: request.params.sessionId,
                pluginId,
                ...parsedBody.data,
            });
            if (!result.ok) return sendPluginRecordError(reply, result);
            return reply.send({ record: result.record });
        }
        const parsedBody = LegacyHostSessionSystemRecordUpsertRequestSchema.safeParse(request.body);
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

    app.delete("/v2/sessions/:sessionId/system-records/record", {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ sessionId: z.string() }),
            body: SessionSystemRecordDeleteRequestSchema,
            response: {
                200: SessionSystemRecordDeleteResponseSchema,
                400: z.object({ error: z.string(), code: z.string().optional() }).passthrough(),
                403: z.object({ error: z.string(), code: z.string() }).passthrough(),
                404: z.object({ error: z.string(), code: z.string() }).passthrough(),
                409: z.object({ error: z.string(), code: z.string(), currentRevision: z.string().optional() }).passthrough(),
                503: z.object({ error: z.string(), code: z.string() }).passthrough(),
                500: z.object({ error: z.string(), code: z.string() }).passthrough(),
            },
        },
    }, async (request, reply) => {
        if (!isSystemRecordV1Request(request)) {
            return reply.code(400).send({
                error: "Plugin Session system record operation failed",
                code: "plugin_session_record_invalid_query",
            });
        }
        if (!isSessionSystemRecordsProtocolV1Active()) {
            return sendPluginRecordError(reply, { code: "plugin_session_records_unavailable" });
        }
        const pluginId = readSystemRecordV1PluginId(request);
        if (!pluginId) return sendPluginRecordError(reply, { code: "plugin_session_record_invalid_query" });
        const parsedBody = SessionSystemRecordDeleteRequestSchema.safeParse(request.body);
        if (!parsedBody.success) return sendPluginRecordError(reply, { code: "plugin_session_record_invalid_query" });
        const result = await deleteSessionSystemRecordV1({
            actorUserId: request.userId,
            sessionId: request.params.sessionId,
            pluginId,
            ...parsedBody.data,
        });
        if (!result.ok) return sendPluginRecordError(reply, result);
        return reply.send({ ok: true });
    });
}
