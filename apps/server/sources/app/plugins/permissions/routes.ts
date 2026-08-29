import type { Fastify } from "@/app/api/types";
import {
    PluginPermissionGrantDismissRequestActionInputV1Schema,
    PluginPermissionGrantGrantActionInputV1Schema,
    PluginPermissionGrantListActionInputV1Schema,
    PluginPermissionGrantRequestActionInputV1Schema,
    PluginPermissionGrantRevokeActionInputV1Schema,
    type PluginMachineMaterializationRefV1,
} from "@happier-dev/protocol";
import type { z } from "zod";

import { PluginPermissionGrantOperationError } from "./errors";
import {
    PluginInstallationPublisherProofError,
    verifyPluginInstallationPublisherHeader,
    type VerifiedPluginInstallationPublisher,
} from "@/app/plugins/installations/publisherProof";
import { authenticateCurrentPluginMaterializationCallerV1 } from "@/app/plugins/availability/callerMaterialization";
import { requirePresentUser } from "@/app/api/utils/requirePresentUser";
import {
    createPluginPermissionGrantOperations,
    type PluginPermissionGrantOperations,
} from "./operations";

export type PluginPermissionGrantRoutesOptions = Readonly<{
    operations?: PluginPermissionGrantOperations;
}>;

const GRANT_LIST_PATH = "/v1/plugins/permissions/grants/list";
const GRANT_REQUEST_PATH = "/v1/plugins/permissions/grants/request";
const GRANT_REVOKE_PATH = "/v1/plugins/permissions/grants/revoke";

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
        const statusCode = error.code.endsWith("_not_found")
            ? 404
            : error.code === "plugin_permission_grant_caller_mismatch"
                || error.code === "plugin_permission_grant_not_owned"
                ? 403
                : 400;
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

/**
 * Resolves the exact current `PluginMachineMaterializationRefV1` caller for
 * the signed plugin branch of a permission route. The caller string is never
 * trusted by itself: it must name the proven machine, resolve to the server's
 * current materialization of the same Account and machine installation, and —
 * for operations that name a plugin — agree with the operation's plugin
 * identity.
 */
async function requireExactPermissionCaller(params: Readonly<{
    accountId: string;
    caller: PluginMachineMaterializationRefV1 | undefined;
    publisher: VerifiedPluginInstallationPublisher;
}>): Promise<VerifiedPluginInstallationPublisher & { callerPluginId: string }> {
    if (!params.caller) {
        throw new PluginPermissionGrantOperationError(
            "plugin_permission_grant_caller_mismatch",
            "Plugin permission route requires the exact current materialization caller provenance",
        );
    }
    const caller = await authenticateCurrentPluginMaterializationCallerV1({
        accountId: params.accountId,
        caller: params.caller,
        publisher: params.publisher,
    });
    if (!caller) {
        throw new PluginPermissionGrantOperationError(
            "plugin_permission_grant_caller_mismatch",
            "Plugin permission caller is not the current materialization of the proven machine installation",
        );
    }
    return {
        ...params.publisher,
        callerPluginId: caller.pluginId,
    };
}

function assertCallerPluginIdMatches(params: Readonly<{
    callerPluginId: string;
    pluginId: string;
}>): void {
    if (params.callerPluginId !== params.pluginId) {
        throw new PluginPermissionGrantOperationError(
            "plugin_permission_grant_caller_mismatch",
            "Plugin permission operation plugin identity does not match the proven caller materialization",
        );
    }
}

export function registerPluginPermissionGrantRoutes(
    app: Fastify,
    options: PluginPermissionGrantRoutesOptions = {},
): void {
    const operations = options.operations ?? createPluginPermissionGrantOperations();

    app.post(GRANT_LIST_PATH, {
        preHandler: app.authenticate,
    }, async (request, reply) => {
        try {
            const userId = requestUserId(request);
            let input = parseGrantRequestInput(PluginPermissionGrantListActionInputV1Schema, request.body ?? {});
            const publisher = await verifyPluginInstallationPublisherHeader({
                accountId: userId,
                request,
                path: GRANT_LIST_PATH,
            });
            if (!publisher && input.caller) {
                throw new PluginInstallationPublisherProofError(
                    "required",
                    "Plugin permission list caller provenance requires a publisher proof",
                );
            }
            if (publisher) {
                // Signed plugin branch: scope the read to the exact proven
                // caller materialization and reject any conflicting filter.
                const caller = await requireExactPermissionCaller({
                    accountId: userId,
                    caller: input.caller,
                    publisher,
                });
                if (input.pluginId !== undefined) {
                    assertCallerPluginIdMatches({
                        callerPluginId: caller.callerPluginId,
                        pluginId: input.pluginId,
                    });
                }
                input = { ...input, pluginId: caller.callerPluginId };
            }
            return await operations.list({
                accountId: userId,
                input,
            });
        } catch (error) {
            return sendOperationError(reply, error);
        }
    });

    app.post(GRANT_REQUEST_PATH, {
        preHandler: app.authenticate,
    }, async (request, reply) => {
        try {
            const userId = requestUserId(request);
            const input = parseGrantRequestInput(PluginPermissionGrantRequestActionInputV1Schema, request.body);
            const verifiedPublisher = await (async () => {
                const publisher = await verifyPluginInstallationPublisherHeader({
                    accountId: userId,
                    request,
                    path: GRANT_REQUEST_PATH,
                });
                if (!publisher) return null;
                const caller = await requireExactPermissionCaller({
                    accountId: userId,
                    caller: input.caller,
                    publisher,
                });
                assertCallerPluginIdMatches({
                    callerPluginId: caller.callerPluginId,
                    pluginId: input.pluginId,
                });
                return caller;
            })();
            return await operations.request({
                accountId: userId,
                userId,
                ...(verifiedPublisher
                    ? {
                        publisher: {
                            kind: "machine_installation" as const,
                            machineId: verifiedPublisher.machineId,
                            installationId: verifiedPublisher.installationId,
                        },
                    }
                    : {}),
                input,
            });
        } catch (error) {
            return sendOperationError(reply, error);
        }
    });

    app.post("/v1/plugins/permissions/grants/grant", {
        preHandler: [app.authenticate, requirePresentUser],
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

    app.post(GRANT_REVOKE_PATH, {
        preHandler: app.authenticate,
    }, async (request, reply) => {
        try {
            const userId = requestUserId(request);
            const input = parseGrantRequestInput(PluginPermissionGrantRevokeActionInputV1Schema, request.body);
            const publisher = await verifyPluginInstallationPublisherHeader({
                accountId: userId,
                request,
                path: GRANT_REVOKE_PATH,
            });
            if (publisher) {
                // Plugin self-revocation: the exact proven caller materialization
                // is bound atomically to the grant inside the operation owner.
                const caller = await requireExactPermissionCaller({
                    accountId: userId,
                    caller: input.caller,
                    publisher,
                });
                return await operations.revoke({
                    accountId: userId,
                    userId,
                    input,
                    selfRevokeAuthority: {
                        pluginId: caller.callerPluginId,
                        machineId: publisher.machineId,
                        installationId: publisher.installationId,
                    },
                });
            }
            if (request.authAuthority !== "present_user") {
                // Do not infer denial from the reply adapter's return value:
                // some compatible adapters return `undefined` after sending.
                // Authority is the authenticated request fact itself.
                return await requirePresentUser(request, reply);
            }
            return await operations.revoke({
                accountId: userId,
                userId,
                input,
            });
        } catch (error) {
            return sendOperationError(reply, error);
        }
    });

    app.post("/v1/plugins/permissions/grants/dismissRequest", {
        preHandler: [app.authenticate, requirePresentUser],
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
