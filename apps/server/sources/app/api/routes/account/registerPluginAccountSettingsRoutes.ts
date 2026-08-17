import {
    PluginAccountSettingsContentV1Schema,
    PluginAccountSettingsMutationRequestV1Schema,
    PluginAccountSettingsMutationResponseV1Schema,
    PluginAccountSettingsReadResponseV1Schema,
    PluginAccountSettingsStorageUnavailableV1Schema,
    PluginIdSchema,
} from "@happier-dev/protocol";
import { z } from "zod";

import {
    mutatePluginDeclarativeSettingsInTx,
    readPluginDeclarativeSettingsInTx,
} from "@/app/kv/pluginDeclarativeSettingsStorage";
import { resolveApiHotEndpointRateLimit } from "@/app/api/utils/apiRateLimitCatalog";
import { asServerProtocolZod } from "@/app/api/utils/protocolComposableZodAdapter";
import { inTx } from "@/storage/inTx";

import { type Fastify } from "../../types";

const PluginAccountSettingsRouteParamsSchema = z.object({
    pluginId: asServerProtocolZod(PluginIdSchema),
}).strict();

const InvalidParamsSchema = z.object({
    error: z.literal("invalid-params"),
}).strict();

const InternalErrorSchema = z.object({
    error: z.literal("internal"),
}).strict();

function unavailable() {
    return { error: "plugin_account_settings_storage_unavailable" as const };
}

function readResponseForStorageResult(result: Awaited<ReturnType<typeof readPluginDeclarativeSettingsInTx>>) {
    if (result.status === "absent") return result;
    if (result.status === "deleted") return result;
    if (result.status !== "present") return null;
    const content = PluginAccountSettingsContentV1Schema.safeParse(result.envelope);
    if (!content.success) return null;
    return {
        status: "present" as const,
        revision: result.revision,
        content: content.data,
    };
}

/**
 * The reserved `(accountId, pluginId)` Settings row is intentionally exposed
 * only through this typed route. Generic KV remains unable to enumerate or
 * mutate this domain.
 */
export function registerPluginAccountSettingsRoutes(app: Fastify): void {
    app.get("/v1/account/plugin-settings/:pluginId", {
        preHandler: app.authenticate,
        config: {
            rateLimit: resolveApiHotEndpointRateLimit(process.env, "account.settings"),
        },
        schema: {
            params: PluginAccountSettingsRouteParamsSchema,
            response: {
                200: PluginAccountSettingsReadResponseV1Schema,
                400: InvalidParamsSchema,
                503: PluginAccountSettingsStorageUnavailableV1Schema,
                500: InternalErrorSchema,
            },
        },
    }, async (request, reply) => {
        try {
            const result = await inTx(async (tx) => await readPluginDeclarativeSettingsInTx(tx, {
                accountId: request.userId,
                pluginId: request.params.pluginId,
            }));
            const response = readResponseForStorageResult(result);
            if (response === null) {
                return reply.code(503).send(unavailable());
            }
            return reply.send(response);
        } catch {
            return reply.code(500).send({ error: "internal" });
        }
    });

    app.post("/v1/account/plugin-settings/:pluginId", {
        preHandler: app.authenticate,
        config: {
            rateLimit: resolveApiHotEndpointRateLimit(process.env, "account.settings"),
        },
        schema: {
            params: PluginAccountSettingsRouteParamsSchema,
            body: PluginAccountSettingsMutationRequestV1Schema,
            response: {
                200: PluginAccountSettingsMutationResponseV1Schema,
                400: InvalidParamsSchema,
                503: PluginAccountSettingsStorageUnavailableV1Schema,
                500: InternalErrorSchema,
            },
        },
    }, async (request, reply) => {
        try {
            const result = await inTx(async (tx) => await mutatePluginDeclarativeSettingsInTx(tx, {
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
