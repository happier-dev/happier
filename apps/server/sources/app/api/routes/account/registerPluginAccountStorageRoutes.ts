import {
    PluginAccountStorageMutationRequestV1Schema,
    PluginAccountStorageMutationResponseV1Schema,
    PluginAccountStorageReadResponseV1Schema,
    PluginAccountStorageUnavailableV1Schema,
    PluginIdSchema,
} from "@happier-dev/protocol";
import { z } from "zod";

import {
    mutatePluginAccountStorageInTx,
    readPluginAccountStorageInTx,
} from "@/app/kv/pluginAccountStorage";
import { readAccountStoredContentCompatibilityForHttpRequest } from "@/app/clientCompatibility/accountStoredContentCompatibility";
import { resolveApiHotEndpointRateLimit } from "@/app/api/utils/apiRateLimitCatalog";
import { asServerProtocolZod } from "@/app/api/utils/protocolComposableZodAdapter";
import { inTx } from "@/storage/inTx";

import { type Fastify } from "../../types";

const PluginAccountStorageRouteParamsSchema = z.object({
    pluginId: asServerProtocolZod(PluginIdSchema),
}).strict();

const InvalidParamsSchema = z.object({
    error: z.literal("invalid-params"),
}).strict();

const InternalErrorSchema = z.object({
    error: z.literal("internal"),
}).strict();

function unavailable() {
    return { error: "plugin_account_storage_unavailable" as const };
}

function readResponseForStorageResult(
    result: Awaited<ReturnType<typeof readPluginAccountStorageInTx>>,
) {
    if (result.status === "absent" || result.status === "deleted") return result;
    if (result.status !== "present") return null;
    return {
        status: "present" as const,
        revision: result.revision,
        content: result.envelope,
    };
}

/**
 * The only authenticated public transport for a plugin's one opaque Account
 * row. It binds Account identity from auth and plugin identity from the route;
 * public generic KV remains unable to address the physical UserKV key.
 */
export function registerPluginAccountStorageRoutes(app: Fastify): void {
    app.get("/v1/account/plugin-storage/:pluginId", {
        preHandler: app.authenticate,
        config: {
            rateLimit: resolveApiHotEndpointRateLimit(process.env, "account.settings"),
        },
        schema: {
            params: PluginAccountStorageRouteParamsSchema,
            response: {
                200: PluginAccountStorageReadResponseV1Schema,
                400: InvalidParamsSchema,
                503: PluginAccountStorageUnavailableV1Schema,
                500: InternalErrorSchema,
            },
        },
    }, async (request, reply) => {
        if (!readAccountStoredContentCompatibilityForHttpRequest(request).supportsPluginDataProtocol) {
            return reply.code(503).send(unavailable());
        }
        try {
            const result = await inTx(async (tx) => await readPluginAccountStorageInTx(tx, {
                accountId: request.userId,
                pluginId: request.params.pluginId,
            }));
            const response = readResponseForStorageResult(result);
            if (response === null) return reply.code(503).send(unavailable());
            return reply.send(response);
        } catch {
            return reply.code(500).send({ error: "internal" });
        }
    });

    app.post("/v1/account/plugin-storage/:pluginId", {
        preHandler: app.authenticate,
        config: {
            rateLimit: resolveApiHotEndpointRateLimit(process.env, "account.settings"),
        },
        schema: {
            params: PluginAccountStorageRouteParamsSchema,
            body: PluginAccountStorageMutationRequestV1Schema,
            response: {
                200: PluginAccountStorageMutationResponseV1Schema,
                400: InvalidParamsSchema,
                503: PluginAccountStorageUnavailableV1Schema,
                500: InternalErrorSchema,
            },
        },
    }, async (request, reply) => {
        if (!readAccountStoredContentCompatibilityForHttpRequest(request).supportsPluginDataProtocol) {
            return reply.code(503).send(unavailable());
        }
        try {
            const result = await inTx(async (tx) => await mutatePluginAccountStorageInTx(tx, {
                accountId: request.userId,
                pluginId: request.params.pluginId,
                expectedRevision: request.body.expectedRevision,
                envelope: request.body.content,
            }));
            if (result.status === "updated" || result.status === "conflict") {
                return reply.send({ status: result.status, revision: result.revision });
            }
            return reply.code(503).send(unavailable());
        } catch {
            return reply.code(500).send({ error: "internal" });
        }
    });
}
