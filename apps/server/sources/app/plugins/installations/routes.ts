import type { Fastify } from "@/app/api/types";
import {
    PluginInstallationManifestDeleteActionInputV1Schema,
    PluginInstallationManifestListActionInputV1Schema,
    PluginInstallationManifestUpsertActionInputV1Schema,
} from "@happier-dev/protocol";
import { z } from "zod";

import { PluginInstallationManifestOperationError } from "./errors";
import {
    createPluginInstallationManifestOperations,
    type PluginInstallationManifestOperations,
} from "./operations";
import {
    PluginInstallationPublisherProofError,
    verifyPluginInstallationPublisherHeader,
} from "./publisherProof";

export type PluginInstallationManifestRoutesOptions = Readonly<{
    operations?: PluginInstallationManifestOperations;
}>;

function requestUserId(request: Readonly<{ userId?: unknown }>): string {
    if (typeof request.userId === "string" && request.userId.length > 0) {
        return request.userId;
    }
    throw new PluginInstallationManifestOperationError(
        "plugin_installation_manifest_authentication_required",
        "Authenticated user principal is required",
    );
}

function sendOperationError(reply: any, error: unknown): unknown {
    if (error instanceof PluginInstallationManifestOperationError) {
        const statusCode = error.code.endsWith("_not_found")
            ? 404
            : error.code.includes("_publisher_proof_")
                ? 403
                : 400;
        return reply.code(statusCode).send({ error: error.code, message: error.message });
    }
    if (error instanceof PluginInstallationPublisherProofError) {
        const code = error.code === "required"
            ? "plugin_installation_manifest_publisher_proof_required"
            : error.code === "expired"
                ? "plugin_installation_manifest_publisher_proof_expired"
                : "plugin_installation_manifest_publisher_proof_invalid";
        const statusCode = error.code === "required" || error.code === "expired" || error.code === "invalid" ? 403 : 400;
        return reply.code(statusCode).send({ error: code, message: error.message });
    }
    throw error;
}

function parseRequestInput<T>(schema: z.ZodType<T>, input: unknown): T {
    const parsed = schema.safeParse(input);
    if (!parsed.success) {
        throw new PluginInstallationManifestOperationError(
            "plugin_installation_manifest_invalid_request",
            "Invalid plugin installation manifest request",
        );
    }
    return parsed.data;
}

export function registerPluginInstallationManifestRoutes(
    app: Fastify,
    options: PluginInstallationManifestRoutesOptions = {},
): void {
    const operations = options.operations ?? createPluginInstallationManifestOperations();

    app.post("/v1/plugins/installations/manifests/list", {
        preHandler: app.authenticate,
    }, async (request, reply) => {
        try {
            const userId = requestUserId(request);
            return await operations.list({
                accountId: userId,
                input: parseRequestInput(PluginInstallationManifestListActionInputV1Schema, request.body ?? {}),
            });
        } catch (error) {
            return sendOperationError(reply, error);
        }
    });

    app.post("/v1/plugins/installations/manifests/upsert", {
        preHandler: app.authenticate,
    }, async (request, reply) => {
        try {
            const userId = requestUserId(request);
            const publisher = await verifyPluginInstallationPublisherHeader({
                accountId: userId,
                request,
                path: "/v1/plugins/installations/manifests/upsert",
                required: true,
            });
            if (!publisher) {
                throw new PluginInstallationManifestOperationError(
                    "plugin_installation_manifest_publisher_proof_required",
                    "Plugin installation manifest publisher proof is required",
                );
            }
            return await operations.upsert({
                accountId: userId,
                machineId: publisher.machineId,
                input: parseRequestInput(PluginInstallationManifestUpsertActionInputV1Schema, request.body),
            });
        } catch (error) {
            return sendOperationError(reply, error);
        }
    });

    app.post("/v1/plugins/installations/manifests/delete", {
        preHandler: app.authenticate,
    }, async (request, reply) => {
        try {
            const userId = requestUserId(request);
            const publisher = await verifyPluginInstallationPublisherHeader({
                accountId: userId,
                request,
                path: "/v1/plugins/installations/manifests/delete",
                required: true,
            });
            if (!publisher) {
                throw new PluginInstallationManifestOperationError(
                    "plugin_installation_manifest_publisher_proof_required",
                    "Plugin installation manifest publisher proof is required",
                );
            }
            return await operations.delete({
                accountId: userId,
                machineId: publisher.machineId,
                input: parseRequestInput(PluginInstallationManifestDeleteActionInputV1Schema, request.body),
            });
        } catch (error) {
            return sendOperationError(reply, error);
        }
    });
}
