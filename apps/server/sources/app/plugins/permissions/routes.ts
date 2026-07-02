import type { Fastify } from "@/app/api/types";
import {
    PluginPermissionGrantDismissRequestActionInputV1Schema,
    PluginPermissionGrantGrantActionInputV1Schema,
    PluginPermissionGrantListActionInputV1Schema,
    PluginPermissionGrantRequestActionInputV1Schema,
    PluginPermissionGrantRevokeActionInputV1Schema,
} from "@happier-dev/protocol";
import type { z } from "zod";

import { PluginPermissionGrantOperationError } from "./errors";
import {
    PluginInstallationPublisherProofError,
    verifyPluginInstallationPublisherHeader,
} from "@/app/plugins/installations/publisherProof";
import {
    createPluginPermissionGrantOperations,
    type PluginPermissionGrantOperations,
} from "./operations";

export type PluginPermissionGrantRoutesOptions = Readonly<{
    operations?: PluginPermissionGrantOperations;
}>;

function requestUserId(request: Readonly<{ userId?: unknown }>): string {
    if (typeof request.userId === "string" && request.userId.length > 0) {
        return request.userId;
    }
    throw new PluginPermissionGrantOperationError(
        "plugin_permission_authentication_required",
        "Authenticated user principal is required",
    );
}

function sendOperationError(reply: any, error: unknown): unknown {
    if (error instanceof PluginPermissionGrantOperationError) {
        const statusCode = error.code.endsWith("_not_found") ? 404 : 400;
        return reply.code(statusCode).send({ error: error.code, message: error.message });
    }
    if (error instanceof PluginInstallationPublisherProofError) {
        const code = error.code === "required"
            ? "plugin_permission_grant_publisher_proof_required"
            : error.code === "expired"
                ? "plugin_permission_grant_publisher_proof_expired"
                : "plugin_permission_grant_publisher_proof_invalid";
        return reply.code(403).send({ error: code, message: error.message });
    }
    throw error;
}

function parseGrantRequestInput<TSchema extends z.ZodType>(
    schema: TSchema,
    input: unknown,
): z.infer<TSchema> {
    const parsed = schema.safeParse(input);
    if (parsed.success) return parsed.data;
    throw new PluginPermissionGrantOperationError(
        "plugin_permission_grant_invalid_request",
        "Plugin permission grant request is invalid",
    );
}

export function registerPluginPermissionGrantRoutes(
    app: Fastify,
    options: PluginPermissionGrantRoutesOptions = {},
): void {
    const operations = options.operations ?? createPluginPermissionGrantOperations();

    app.post("/v1/plugins/permissions/grants/list", {
        preHandler: app.authenticate,
    }, async (request, reply) => {
        try {
            const userId = requestUserId(request);
            return await operations.list({
                accountId: userId,
                input: parseGrantRequestInput(PluginPermissionGrantListActionInputV1Schema, request.body ?? {}),
            });
        } catch (error) {
            return sendOperationError(reply, error);
        }
    });

    app.post("/v1/plugins/permissions/grants/request", {
        preHandler: app.authenticate,
    }, async (request, reply) => {
        try {
            const userId = requestUserId(request);
            const publisher = await verifyPluginInstallationPublisherHeader({
                accountId: userId,
                request,
                path: "/v1/plugins/permissions/grants/request",
            });
            return await operations.request({
                accountId: userId,
                userId,
                ...(publisher
                    ? {
                        publisher: {
                            kind: "machine_installation",
                            machineId: publisher.machineId,
                            installationId: publisher.installationId,
                        },
                    }
                    : {}),
                input: parseGrantRequestInput(PluginPermissionGrantRequestActionInputV1Schema, request.body),
            });
        } catch (error) {
            return sendOperationError(reply, error);
        }
    });

    app.post("/v1/plugins/permissions/grants/grant", {
        preHandler: app.authenticate,
    }, async (request, reply) => {
        try {
            const userId = requestUserId(request);
            return await operations.grant({
                accountId: userId,
                userId,
                input: parseGrantRequestInput(PluginPermissionGrantGrantActionInputV1Schema, request.body),
            });
        } catch (error) {
            return sendOperationError(reply, error);
        }
    });

    app.post("/v1/plugins/permissions/grants/revoke", {
        preHandler: app.authenticate,
    }, async (request, reply) => {
        try {
            const userId = requestUserId(request);
            return await operations.revoke({
                accountId: userId,
                userId,
                input: parseGrantRequestInput(PluginPermissionGrantRevokeActionInputV1Schema, request.body),
            });
        } catch (error) {
            return sendOperationError(reply, error);
        }
    });

    app.post("/v1/plugins/permissions/grants/dismissRequest", {
        preHandler: app.authenticate,
    }, async (request, reply) => {
        try {
            const userId = requestUserId(request);
            return await operations.dismissRequest({
                accountId: userId,
                userId,
                input: parseGrantRequestInput(PluginPermissionGrantDismissRequestActionInputV1Schema, request.body),
            });
        } catch (error) {
            return sendOperationError(reply, error);
        }
    });
}
