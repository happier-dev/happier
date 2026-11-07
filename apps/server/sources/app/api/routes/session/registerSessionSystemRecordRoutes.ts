import { z } from "zod/mini";
import { pick } from "zod/mini";
import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";

import {
    getLatestSessionSystemRecord,
    getSessionSystemRecord,
    deleteSessionSystemRecordV1,
    listPermissionMediationRecords,
    prunePermissionMediationRecord,
    listSessionSystemRecords,
    listSessionSystemRecordsV1,
    countSessionBoardItemsV1,
    readSessionSystemRecordV1,
    readPermissionMediationRecord,
    upsertSessionSystemRecord,
    upsertSessionSystemRecordV1,
    writePermissionMediationRecord,
} from "@/app/session/systemRecords/sessionSystemRecordService";
import { isSessionSystemRecordsProtocolV1Active } from "@/app/session/systemRecords/sessionSystemRecordProtocolContract";
import { sessionSystemRecordV1ErrorStatus, toPublicSessionSystemRecord } from "@/app/session/systemRecords/sessionSystemRecordSerialization";
import { LegacyHostSessionSystemRecordLatestQuerySchema, LegacyHostSessionSystemRecordLatestResponseSchema, LegacyHostSessionSystemRecordListQuerySchema, LegacyHostSessionSystemRecordLookupQuerySchema, LegacyHostSessionSystemRecordLookupResponseSchema, LegacyHostSessionSystemRecordPageResponseSchema, LegacyHostSessionSystemRecordUpsertRequestSchema, LegacyHostSessionSystemRecordUpsertResponseSchema, SESSION_SYSTEM_RECORDS_PLUGIN_ID_HEADER, SESSION_SYSTEM_RECORDS_PROTOCOL_HTTP_HEADER, SESSION_SYSTEM_RECORDS_PROTOCOL_V1_HTTP_HEADER_VALUE, SessionSystemRecordErrorResponseSchema, SessionSystemRecordDeleteRequestSchema, SessionSystemRecordDeleteResponseSchema, SessionSystemRecordListQuerySchema, SessionSystemRecordStoredPageResponseSchema, SessionSystemRecordStoredReadResponseSchema, SessionSystemRecordStoredUpsertRequestSchema, SessionSystemRecordStoredUpsertResponseSchema, SessionPermissionMediationRecordListQuerySchema, SessionPermissionMediationRecordListResponseSchema, SessionPermissionMediationRecordReadResponseSchema, SessionPermissionMediationRecordPruneRequestSchema, SessionPermissionMediationRecordPruneResponseSchema, SessionPermissionMediationRecordWriteRequestSchema, SessionPermissionMediationRecordWriteResponseSchema } from '@happier-dev/protocol/sessions/system/records/sessionSystemRecordRoutes';
import { PluginIdSchema } from '@happier-dev/protocol/plugins/plugin-id';
import { SessionSystemRecordAddressSchema } from '@happier-dev/protocol/sessions/system/records/sessionSystemRecordAddress';
import { SessionSystemRecordCountQuerySchema, SessionSystemRecordCountResponseSchema } from '@happier-dev/protocol/sessions/system/records/sessionSystemRecordRoutes';
import { SessionPermissionMediationRecordIdentityV1Schema } from '@happier-dev/protocol/sessions/permissions/mediationRecordsV1';
import { type Fastify } from "../../types";
import { readSessionAccessAuthenticationFromRequest } from "@/app/session/access/sessionAccessAuthentication";

const PERMISSION_MEDIATION_RECORD_ERROR_RESPONSE_SCHEMA = z.strictObject({
    error: z.string(),
    code: z.string(),
    currentRevision: z.optional(z.string()),
});

const PERMISSION_MEDIATION_RECORD_ROUTE_PARAMS_SCHEMA = SessionPermissionMediationRecordIdentityV1Schema;
const PERMISSION_MEDIATION_RECORD_LIST_ROUTE_PARAMS_SCHEMA = pick(SessionPermissionMediationRecordIdentityV1Schema, {
    sessionId: true,
});

function isSystemRecordV1Request(request: Readonly<{ headers: Record<string, unknown> }>): boolean {
    return request.headers[SESSION_SYSTEM_RECORDS_PROTOCOL_HTTP_HEADER] === SESSION_SYSTEM_RECORDS_PROTOCOL_V1_HTTP_HEADER_VALUE;
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

function hasUnmistakableSystemRecordV1MutationIntent(body: unknown): boolean {
    return Boolean(body && typeof body === "object" && !Array.isArray(body)
        && Object.prototype.hasOwnProperty.call(body, "address"));
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
    return reply.code(sessionSystemRecordV1ErrorStatus(result.code)).send(payload);
}

function handleSystemRecordRouteError(
    error: FastifyError,
    request: FastifyRequest,
    reply: FastifyReply,
): FastifyReply {
    if (!error.validation) throw error;
    if (
        isSystemRecordV1Request(request)
        || hasUnmistakableSystemRecordV1GetIntent(request.query)
        || hasUnmistakableSystemRecordV1MutationIntent(request.body)
        || request.method === "DELETE"
    ) {
        return sendPluginRecordError(reply, { code: "plugin_session_record_invalid_query" });
    }
    return reply.code(400).send({ error: "Invalid parameters" });
}

function handleLegacySystemRecordRouteError(
    error: FastifyError,
    _request: FastifyRequest,
    reply: FastifyReply,
): FastifyReply {
    if (!error.validation) throw error;
    return reply.code(400).send({ error: "Invalid parameters" });
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
    const withPluginRecordError = <T extends z.ZodMiniType>(legacy: T) => (
        z.union([legacy, SessionSystemRecordErrorResponseSchema])
    );

    // This is a narrow host-owned transport, not a generic System Records
    // endpoint.  It intentionally receives no plugin id or namespace from the
    // request, because a bearer-authenticated HTTP caller cannot attest a
    // plugin namespace.
    app.get("/v2/sessions/:sessionId/permission-mediation-records", {
        preHandler: app.authenticate,
        config: {
            allowApiToken: true,
            restrictedCredentialBinding: { scope: "session", session: "params.sessionId" },
        },
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
            authentication: readSessionAccessAuthenticationFromRequest(request),
        });
        if (!result.ok) return sendPermissionMediationRecordError(reply, result);
        return reply.send({
            ...result.page,
            records: [...result.page.records],
        });
    });

    app.get("/v2/sessions/:sessionId/permission-mediation-records/:turnId/:requestId", {
        preHandler: app.authenticate,
        config: {
            allowApiToken: true,
            restrictedCredentialBinding: { scope: "session", session: "params.sessionId" },
        },
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
            authentication: readSessionAccessAuthenticationFromRequest(request),
        });
        if (!result.ok) return sendPermissionMediationRecordError(reply, result);
        return reply.send({ record: result.record });
    });

    app.put("/v2/sessions/:sessionId/permission-mediation-records/:turnId/:requestId", {
        preHandler: app.authenticate,
        config: {
            allowApiToken: true,
            restrictedCredentialBinding: { scope: "session", session: "params.sessionId" },
        },
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
            authentication: readSessionAccessAuthenticationFromRequest(request),
        });
        if (!result.ok) return sendPermissionMediationRecordError(reply, result);
        return reply.send({ record: result.record });
    });

    // Retention is the only typed deletion operation. The Permission owner
    // first opens an encrypted row, proves it inactive, then supplies the
    // exact revision; this endpoint never exposes generic host CRUD.
    app.delete("/v2/sessions/:sessionId/permission-mediation-records/:turnId/:requestId", {
        preHandler: app.authenticate,
        config: {
            allowApiToken: true,
            restrictedCredentialBinding: { scope: "session", session: "params.sessionId" },
        },
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
            authentication: readSessionAccessAuthenticationFromRequest(request),
        });
        if (!result.ok) return sendPermissionMediationRecordError(reply, result);
        return reply.send({ ok: true });
    });

    app.get("/v2/sessions/:sessionId/system-records", {
        preHandler: app.authenticate,
        errorHandler: handleSystemRecordRouteError,
        config: {
            allowApiToken: true,
            restrictedCredentialBinding: { scope: "session", session: "params.sessionId" },
        },
        schema: {
            params: z.object({ sessionId: z.string() }),
            querystring: z.optional(z.union([
                SessionSystemRecordCountQuerySchema,
                SessionSystemRecordListQuerySchema,
                LegacyHostSessionSystemRecordListQuerySchema,
            ])),
            response: {
                200: z.union([SessionSystemRecordCountResponseSchema, SessionSystemRecordStoredPageResponseSchema, LegacyHostSessionSystemRecordPageResponseSchema]),
                400: withPluginRecordError(z.object({ error: z.literal("Invalid parameters") })),
                403: withPluginRecordError(z.object({ error: z.literal("Forbidden") })),
                404: withPluginRecordError(z.object({ error: z.enum(["Session not found", "not_found"]) })),
                409: SessionSystemRecordErrorResponseSchema,
                503: SessionSystemRecordErrorResponseSchema,
                500: withPluginRecordError(z.object({ error: z.literal("Failed to list system records") })),
            },
        },
    }, async (request, reply) => {
        if (isSystemRecordV1Request(request)) {
            if (!isSessionSystemRecordsProtocolV1Active()) {
                return sendPluginRecordError(reply, { code: "plugin_session_records_unavailable" });
            }
            const countQuery = SessionSystemRecordCountQuerySchema.safeParse(request.query);
            if (countQuery.success) {
                const result = await countSessionBoardItemsV1({
                    actorUserId: request.userId, sessionId: request.params.sessionId,
                    authentication: readSessionAccessAuthenticationFromRequest(request),
                });
                if (!result.ok) return sendPluginRecordError(reply, result);
                return reply.send({ count: result.count });
            }
            const parsedQuery = SessionSystemRecordListQuerySchema.safeParse(request.query ?? {});
            if (!parsedQuery.success) return sendPluginRecordError(reply, { code: "plugin_session_record_invalid_query" });
            const pluginId = parsedQuery.data.owner === "plugin" ? readSystemRecordV1PluginId(request) : undefined;
            if (parsedQuery.data.owner === "plugin" && !pluginId) return sendPluginRecordError(reply, { code: "plugin_session_record_invalid_query" });
            const result = await listSessionSystemRecordsV1({
                actorUserId: request.userId,
                sessionId: request.params.sessionId,
                pluginId: pluginId ?? undefined,
                query: parsedQuery.data,
                authentication: readSessionAccessAuthenticationFromRequest(request),
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
            authentication: readSessionAccessAuthenticationFromRequest(request),
        });

        if (!result.ok) {
            if (result.error === "invalid-params") return reply.code(400).send({ error: "Invalid parameters" });
            if (result.error === "forbidden") return reply.code(403).send({ error: "Forbidden" });
            if (result.error === "session-not-found") return reply.code(404).send({ error: "Session not found" });
            return reply.code(500).send({ error: "Failed to list system records" });
        }

        return reply.send(LegacyHostSessionSystemRecordPageResponseSchema.parse({
            records: result.records.map(toPublicSessionSystemRecord),
            nextCursor: result.nextCursor,
            hasNext: result.nextCursor !== null,
        }));
    });

    app.get("/v2/sessions/:sessionId/system-records/record", {
        preHandler: app.authenticate,
        errorHandler: handleSystemRecordRouteError,
        config: {
            allowApiToken: true,
            restrictedCredentialBinding: { scope: "session", session: "params.sessionId" },
        },
        schema: {
            params: z.object({ sessionId: z.string() }),
            querystring: z.union([SessionSystemRecordAddressSchema, LegacyHostSessionSystemRecordLookupQuerySchema]),
            response: {
                200: z.union([SessionSystemRecordStoredReadResponseSchema, LegacyHostSessionSystemRecordLookupResponseSchema]),
                400: withPluginRecordError(z.object({ error: z.literal("Invalid parameters") })),
                403: withPluginRecordError(z.object({ error: z.literal("Forbidden") })),
                404: withPluginRecordError(z.object({ error: z.enum(["Session not found", "not_found"]) })),
                409: SessionSystemRecordErrorResponseSchema,
                503: SessionSystemRecordErrorResponseSchema,
                500: withPluginRecordError(z.object({ error: z.literal("Failed to fetch system record") })),
            },
        },
    }, async (request, reply) => {
        if (isSystemRecordV1Request(request)) {
            if (!isSessionSystemRecordsProtocolV1Active()) {
                return sendPluginRecordError(reply, { code: "plugin_session_records_unavailable" });
            }
            const parsedAddress = SessionSystemRecordAddressSchema.safeParse(request.query);
            if (!parsedAddress.success) return sendPluginRecordError(reply, { code: "plugin_session_record_invalid_query" });
            const pluginId = parsedAddress.data.owner === "plugin" ? readSystemRecordV1PluginId(request) : undefined;
            if (parsedAddress.data.owner === "plugin" && !pluginId) return sendPluginRecordError(reply, { code: "plugin_session_record_invalid_query" });
            const result = await readSessionSystemRecordV1({
                actorUserId: request.userId,
                sessionId: request.params.sessionId,
                pluginId: pluginId ?? undefined,
                address: parsedAddress.data,
                authentication: readSessionAccessAuthenticationFromRequest(request),
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
            authentication: readSessionAccessAuthenticationFromRequest(request),
        });

        if (!result.ok) {
            if (result.error === "invalid-params") return reply.code(400).send({ error: "Invalid parameters" });
            if (result.error === "forbidden") return reply.code(403).send({ error: "Forbidden" });
            if (result.error === "session-not-found") return reply.code(404).send({ error: "Session not found" });
            return reply.code(500).send({ error: "Failed to fetch system record" });
        }

        return reply.send(LegacyHostSessionSystemRecordLookupResponseSchema.parse({
            record: result.record ? toPublicSessionSystemRecord(result.record) : null,
        }));
    });

    app.get("/v2/sessions/:sessionId/system-records/latest", {
        preHandler: app.authenticate,
        errorHandler: handleLegacySystemRecordRouteError,
        config: {
            allowApiToken: true,
            restrictedCredentialBinding: { scope: "session", session: "params.sessionId" },
        },
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
            authentication: readSessionAccessAuthenticationFromRequest(request),
        });

        if (!result.ok) {
            if (result.error === "invalid-params") return reply.code(400).send({ error: "Invalid parameters" });
            if (result.error === "forbidden") return reply.code(403).send({ error: "Forbidden" });
            if (result.error === "session-not-found") return reply.code(404).send({ error: "Session not found" });
            return reply.code(500).send({ error: "Failed to fetch latest system record" });
        }

        return reply.send(LegacyHostSessionSystemRecordLatestResponseSchema.parse({
            record: result.record ? toPublicSessionSystemRecord(result.record) : null,
        }));
    });

    app.put("/v2/sessions/:sessionId/system-records", {
        preHandler: app.authenticate,
        errorHandler: handleSystemRecordRouteError,
        config: {
            allowApiToken: true,
            restrictedCredentialBinding: { scope: "session", session: "params.sessionId" },
        },
        schema: {
            params: z.object({ sessionId: z.string() }),
            body: z.union([SessionSystemRecordStoredUpsertRequestSchema, LegacyHostSessionSystemRecordUpsertRequestSchema]),
            response: {
                200: z.union([SessionSystemRecordStoredUpsertResponseSchema, LegacyHostSessionSystemRecordUpsertResponseSchema]),
                400: withPluginRecordError(z.looseObject({ error: z.literal("Invalid parameters"), code: z.optional(z.string()) })),
                403: withPluginRecordError(z.object({ error: z.literal("Forbidden") })),
                404: withPluginRecordError(z.object({ error: z.enum(["Session not found", "not_found"]) })),
                409: withPluginRecordError(z.looseObject({ error: z.literal("Conflict"), code: z.string() })),
                503: SessionSystemRecordErrorResponseSchema,
                500: withPluginRecordError(z.object({ error: z.literal("Failed to upsert system record") })),
            },
        },
    }, async (request, reply) => {
        if (isSystemRecordV1Request(request)) {
            if (!isSessionSystemRecordsProtocolV1Active()) {
                return sendPluginRecordError(reply, { code: "plugin_session_records_unavailable" });
            }
            const parsedBody = SessionSystemRecordStoredUpsertRequestSchema.safeParse(request.body);
            if (!parsedBody.success) return sendPluginRecordError(reply, { code: "plugin_session_record_invalid_query" });
            const pluginId = parsedBody.data.address.owner === "plugin" ? readSystemRecordV1PluginId(request) : undefined;
            if (parsedBody.data.address.owner === "plugin" && !pluginId) return sendPluginRecordError(reply, { code: "plugin_session_record_invalid_query" });
            const result = await upsertSessionSystemRecordV1({
                actorUserId: request.userId,
                sessionId: request.params.sessionId,
                pluginId: pluginId ?? undefined,
                ...parsedBody.data,
                authentication: readSessionAccessAuthenticationFromRequest(request),
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
            authentication: readSessionAccessAuthenticationFromRequest(request),
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

        return reply.send(LegacyHostSessionSystemRecordUpsertResponseSchema.parse({
            didCreate: result.didCreate,
            didUpdate: result.didUpdate,
            record: toPublicSessionSystemRecord(result.record),
        }));
    });

    app.delete("/v2/sessions/:sessionId/system-records/record", {
        preHandler: app.authenticate,
        errorHandler: handleSystemRecordRouteError,
        config: {
            allowApiToken: true,
            restrictedCredentialBinding: { scope: "session", session: "params.sessionId" },
        },
        schema: {
            params: z.object({ sessionId: z.string() }),
            body: SessionSystemRecordDeleteRequestSchema,
            response: {
                200: SessionSystemRecordDeleteResponseSchema,
                400: z.looseObject({ error: z.string(), code: z.optional(z.string()) }),
                403: z.looseObject({ error: z.string(), code: z.string() }),
                404: z.looseObject({ error: z.string(), code: z.string() }),
                409: z.looseObject({ error: z.string(), code: z.string(), currentRevision: z.optional(z.string()) }),
                503: z.looseObject({ error: z.string(), code: z.string() }),
                500: z.looseObject({ error: z.string(), code: z.string() }),
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
        const parsedBody = SessionSystemRecordDeleteRequestSchema.safeParse(request.body);
        if (!parsedBody.success) return sendPluginRecordError(reply, { code: "plugin_session_record_invalid_query" });
        const pluginId = parsedBody.data.address.owner === "plugin" ? readSystemRecordV1PluginId(request) : undefined;
        if (parsedBody.data.address.owner === "plugin" && !pluginId) return sendPluginRecordError(reply, { code: "plugin_session_record_invalid_query" });
        const result = await deleteSessionSystemRecordV1({
            actorUserId: request.userId,
            sessionId: request.params.sessionId,
            pluginId: pluginId ?? undefined,
            ...parsedBody.data,
            authentication: readSessionAccessAuthenticationFromRequest(request),
        });
        if (!result.ok) return sendPluginRecordError(reply, result);
        return reply.send({ ok: true });
    });
}
