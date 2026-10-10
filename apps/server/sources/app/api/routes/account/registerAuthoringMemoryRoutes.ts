import {
    AUTHORING_MEMORY_ROUTE_V1,
    AuthoringMemoryKeyV1Schema,
    AuthoringMemoryListResponseV1Schema,
    AuthoringMemoryMutationRequestV1Schema,
    AuthoringMemoryMutationResponseV1Schema,
    AuthoringMemoryReadResponseV1Schema,
    AuthoringMemoryStorageUnavailableV1Schema,
} from "@happier-dev/protocol";
import { z } from "zod";

import type { Fastify } from "@/app/api/types";
import { resolveApiHotEndpointRateLimit } from "@/app/api/utils/apiRateLimitCatalog";
import { asServerProtocolZod } from "@/app/api/utils/protocolComposableZodAdapter";
import { listAuthoringMemoryInTx, mutateAuthoringMemoryInTx, readAuthoringMemoryInTx } from "@/app/kv/authoringMemoryStorage";
import { inTx } from "@/storage/inTx";

const AuthoringMemoryRouteParamsSchema = z.object({ key: asServerProtocolZod(AuthoringMemoryKeyV1Schema) }).strict();
const InvalidParamsSchema = z.object({ error: z.literal("invalid-params") }).strict();
const InternalErrorSchema = z.object({ error: z.literal("internal") }).strict();

function unavailable() {
    return { error: "authoring_memory_storage_unavailable" as const };
}

function readResponse(result: Awaited<ReturnType<typeof readAuthoringMemoryInTx>>) {
    if (result.status === "absent" || result.status === "deleted") return result;
    if (result.status !== "present") return null;
    return { status: "present" as const, revision: result.revision, content: result.envelope };
}

/** The Account auth identity owns every row; generic KV cannot address them. */
export function registerAuthoringMemoryRoutes(app: Fastify): void {
    app.get(`${AUTHORING_MEMORY_ROUTE_V1}/:key`, {
        preHandler: app.authenticate,
        config: { rateLimit: resolveApiHotEndpointRateLimit(process.env, "account.settings") },
        schema: {
            params: AuthoringMemoryRouteParamsSchema,
            response: {
                200: asServerProtocolZod(AuthoringMemoryReadResponseV1Schema),
                400: InvalidParamsSchema,
                503: asServerProtocolZod(AuthoringMemoryStorageUnavailableV1Schema),
                500: InternalErrorSchema,
            },
        },
    }, async (request, reply) => {
        try {
            const result = await inTx(tx => readAuthoringMemoryInTx(tx, { accountId: request.userId, key: request.params.key }), { readOnly: true });
            const response = readResponse(result);
            if (response === null) return reply.code(503).send(unavailable());
            return reply.send(response);
        } catch {
            return reply.code(500).send({ error: "internal" });
        }
    });
    app.post(`${AUTHORING_MEMORY_ROUTE_V1}/:key`, {
        preHandler: app.authenticate,
        config: { rateLimit: resolveApiHotEndpointRateLimit(process.env, "account.settings") },
        schema: {
            params: AuthoringMemoryRouteParamsSchema,
            body: asServerProtocolZod(AuthoringMemoryMutationRequestV1Schema),
            response: {
                200: asServerProtocolZod(AuthoringMemoryMutationResponseV1Schema),
                400: InvalidParamsSchema,
                503: asServerProtocolZod(AuthoringMemoryStorageUnavailableV1Schema),
                500: InternalErrorSchema,
            },
        },
    }, async (request, reply) => {
        try {
            const result = await inTx(tx => mutateAuthoringMemoryInTx(tx, {
                accountId: request.userId, key: request.params.key,
                expectedRevision: request.body.expectedRevision, envelope: request.body.content,
            }));
            if (result.status === "updated" || result.status === "conflict") return reply.send(result);
            return reply.code(503).send(unavailable());
        } catch {
            return reply.code(500).send({ error: "internal" });
        }
    });
    app.get(AUTHORING_MEMORY_ROUTE_V1, {
        preHandler: app.authenticate,
        config: { rateLimit: resolveApiHotEndpointRateLimit(process.env, "account.settings") },
        schema: { response: {
            200: asServerProtocolZod(AuthoringMemoryListResponseV1Schema),
            503: asServerProtocolZod(AuthoringMemoryStorageUnavailableV1Schema),
            500: z.object({ error: z.literal("internal") }).strict(),
        } },
    }, async (request, reply) => {
        try {
            const result = await inTx(tx => listAuthoringMemoryInTx(tx, { accountId: request.userId }), { readOnly: true });
            if (result.status !== "listed") return reply.code(503).send({ error: "authoring_memory_storage_unavailable" });
            return reply.send({ rows: [...result.rows] });
        } catch {
            return reply.code(500).send({ error: "internal" });
        }
    });
}
