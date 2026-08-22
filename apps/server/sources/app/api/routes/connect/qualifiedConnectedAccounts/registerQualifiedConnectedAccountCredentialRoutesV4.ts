import { z } from "zod";
import {
    QualifiedConnectedAccountConfigurationPatchV4Schema,
    QualifiedConnectedAccountConfigurationSnapshotV4Schema,
    QualifiedConnectedAccountConfigurationTargetV4Schema,
    QualifiedConnectedAccountCredentialErrorV4Schema,
    QualifiedConnectedAccountCredentialHealthPatchV4Schema,
    QualifiedConnectedAccountCredentialDeleteV4Schema,
    QualifiedConnectedAccountCredentialMutationSuccessV4Schema,
    QualifiedConnectedAccountCredentialMutationV4Schema,
    QualifiedConnectedAccountCredentialSnapshotV4Schema,
    QualifiedConnectedAccountListResponseV4Schema,
    QualifiedConnectedAccountRefSchema,
    QualifiedConnectedAccountRefreshLeaseV4Schema,
    QualifiedConnectedAccountRefreshLeaseResponseV4Schema,
    QualifiedConnectedAccountQuotaQueryV4Schema,
    QualifiedConnectedAccountQuotaResponseV4Schema,
    QualifiedConnectedAccountGroupCreateV4Schema,
    QualifiedConnectedAccountGroupPatchV4Schema,
    QualifiedConnectedAccountGroupRuntimeStatePatchV4Schema,
    QualifiedConnectedAccountGroupMemberMutationV4Schema,
    QualifiedConnectedAccountGroupMemberDeleteV4Schema,
    QualifiedConnectedAccountGroupActiveAccountV4Schema,
    QualifiedConnectedAccountGroupIncarnationV4Schema,
    QualifiedConnectedAccountGroupRefSchema,
    QualifiedConnectedAccountGroupListResponseV4Schema,
    QualifiedConnectedAccountGroupResponseV4Schema,
    QualifiedConnectedAccountSuccessV4Schema,
    QualifiedConnectedServiceUsageSourceV4Schema,
    QualifiedConnectedServiceUsageSourceResolutionV4Schema,
    QualifiedProviderAccountUsageWriteV4Schema,
    QualifiedProviderAccountUsageWriteSuccessV4Schema,
    QualifiedProviderAccountUsageRecordQueryV4Schema,
    QualifiedProviderAccountUsageRecordResponseV4Schema,
    QualifiedConnectedAccountServiceRefSchema,
    parseQualifiedConnectedAccountV4StructuredQueryValue,
} from "@happier-dev/protocol";

import type { Fastify } from "../../../types";
import {
    listQualifiedConnectedAccounts,
    acquireQualifiedConnectedServiceRefreshLease,
    deleteQualifiedConnectedServiceCredential,
    mutateQualifiedConnectedAccountConfiguration,
    mutateQualifiedConnectedServiceCredential,
    mutateQualifiedConnectedServiceCredentialHealth,
    readQualifiedConnectedAccountConfiguration,
    readQualifiedConnectedServiceCredential,
} from "./credentialRepository";
import {
    createQualifiedConnectedAccountGroup,
    createQualifiedConnectedAccountGroupMember,
    deleteQualifiedConnectedAccountGroup,
    deleteQualifiedConnectedAccountGroupMember,
    listQualifiedConnectedAccountGroups,
    patchQualifiedConnectedAccountGroup,
    patchQualifiedConnectedAccountGroupRuntimeState,
    readQualifiedConnectedAccountGroup,
    setQualifiedConnectedAccountGroupActiveAccount,
    updateQualifiedConnectedAccountGroupMember,
} from "./groupRepository";
import {
    deleteQualifiedProviderAccountUsageRecord,
    readExactQualifiedConnectedServiceUsageSource,
    readQualifiedProviderAccountUsageRecord,
    readQualifiedConnectedAccountQuota,
    requestQualifiedProviderAccountUsageRefresh,
    requestQualifiedConnectedAccountQuotaRefresh,
    QualifiedConnectedAccountUsageBasisError,
    unlinkQualifiedConnectedAccountQuota,
    writeQualifiedProviderAccountUsageRecord,
} from "./usageRepository";
import {
    ConnectedServiceUsageSourceBindingError,
    ConnectedServiceUsageSourceOwnershipError,
    ProviderAccountUsagePayloadInvariantError,
} from "../providerAccountUsage/types";

type QualifiedConnectedAccountCredentialRouteDependencies = Readonly<{
    listQualifiedConnectedAccounts:
        typeof listQualifiedConnectedAccounts;
    mutateQualifiedConnectedServiceCredential:
        typeof mutateQualifiedConnectedServiceCredential;
    readQualifiedConnectedServiceCredential:
        typeof readQualifiedConnectedServiceCredential;
    readQualifiedConnectedAccountConfiguration:
        typeof readQualifiedConnectedAccountConfiguration;
    mutateQualifiedConnectedAccountConfiguration:
        typeof mutateQualifiedConnectedAccountConfiguration;
    mutateQualifiedConnectedServiceCredentialHealth:
        typeof mutateQualifiedConnectedServiceCredentialHealth;
}>;

const defaultDependencies:
    QualifiedConnectedAccountCredentialRouteDependencies = {
        listQualifiedConnectedAccounts,
        mutateQualifiedConnectedServiceCredential,
        readQualifiedConnectedServiceCredential,
        readQualifiedConnectedAccountConfiguration,
        mutateQualifiedConnectedAccountConfiguration,
        mutateQualifiedConnectedServiceCredentialHealth,
    };

const StructuredServiceQuerySchema = z.object({
    service: z.union([z.string(), z.array(z.string())]),
}).strict();
const StructuredRefQuerySchema = z.object({
    ref: z.union([z.string(), z.array(z.string())]),
}).strict();
const StructuredConfigurationTargetQuerySchema = z.object({
    target: z.union([z.string(), z.array(z.string())]),
}).strict();
const StructuredGroupQuerySchema = z.object({
    group: z.union([z.string(), z.array(z.string())]),
    expectedRuntimeStateRevision: z.string().optional(),
}).strict();
const StructuredGroupDeleteQuerySchema = z.object({
    group: z.union([z.string(), z.array(z.string())]),
    expectedRuntimeStateRevision: z.string().optional(),
    expectedIncarnation: z.string().optional(),
}).strict();
const StructuredGroupMemberDeleteQuerySchema = z.object({
    mutation: z.union([z.string(), z.array(z.string())]),
}).strict();
const StructuredUsageSourceQuerySchema = z.object({
    source: z.union([z.string(), z.array(z.string())]),
}).strict();
const CredentialDeleteQuerySchema = z.object({
    ref: z.union([z.string(), z.array(z.string())]),
    expectedCredentialRevision: z.string().trim().min(1).max(128),
    cleanupGroupReferences: z.enum(["true", "false"]),
}).strict();
const ProviderUsageRecordQuerySchema =
    QualifiedProviderAccountUsageRecordQueryV4Schema;

const NotFoundResponseSchema = z.object({
    error: z.enum([
        "connect_credential_not_found",
        "connect_quotas_not_found",
        "connect_group_not_found",
        "provider_account_usage_source_not_found",
        "provider_account_usage_not_found",
    ]),
}).strict();
const GroupConflictResponseSchema = z.object({
    error: z.enum([
        "connect_group_already_exists",
        "connect_group_generation_conflict",
        "connect_group_incarnation_conflict",
        "connect_group_runtime_state_revision_conflict",
        "connect_group_member_already_exists",
        "connect_group_member_not_found",
        "connect_group_active_profile_not_member",
        "connect_group_source_revision_conflict",
        "connect_group_profile_runtime_cooldown",
    ]),
    runtimeStateRevision: z.number().int().nonnegative().nullable().optional(),
    generation: z.number().int().nonnegative().optional(),
    resetAtMs: z.number().int().nonnegative().optional(),
}).strict();

function parseOptionalCanonicalInteger(
    value: string | undefined,
): number | undefined {
    if (value === undefined) return undefined;
    if (!/^(0|[1-9]\d*)$/.test(value)) {
        throw new Error("Expected canonical non-negative integer");
    }
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed)) {
        throw new Error("Expected safe integer");
    }
    return parsed;
}

function parseOptionalQualifiedGroupIncarnation(
    value: string | undefined,
): string | undefined {
    return value === undefined
        ? undefined
        : QualifiedConnectedAccountGroupIncarnationV4Schema.parse(value);
}

export function registerQualifiedConnectedAccountCredentialRoutesV4(
    app: Fastify,
    dependencies:
        Partial<QualifiedConnectedAccountCredentialRouteDependencies> = {},
): void {
    const routeDependencies = {
        ...defaultDependencies,
        ...dependencies,
    };
    app.get("/v4/connect/qualified/accounts", {
        preHandler: app.authenticate,
        schema: {
            querystring: StructuredServiceQuerySchema,
            response: {
                200: QualifiedConnectedAccountListResponseV4Schema,
                400: z.object({
                    error: z.literal("invalid-params"),
                }).strict(),
            },
        },
    }, async (request, reply) => {
        let service;
        try {
            service =
                parseQualifiedConnectedAccountV4StructuredQueryValue(
                    QualifiedConnectedAccountServiceRefSchema,
                    request.query.service,
                );
        } catch {
            return reply.code(400).send({ error: "invalid-params" });
        }
        const accounts =
            await routeDependencies.listQualifiedConnectedAccounts({
            accountId: request.userId,
            service,
        });
        return reply.send({ service, accounts });
    });

    app.post("/v4/connect/qualified/credential", {
        preHandler: app.authenticate,
        schema: {
            body: QualifiedConnectedAccountCredentialMutationV4Schema,
            response: {
                200:
                    QualifiedConnectedAccountCredentialMutationSuccessV4Schema,
                400: z.object({
                    error: z.literal("invalid-params"),
                }).strict(),
                409: QualifiedConnectedAccountCredentialErrorV4Schema,
            },
        },
    }, async (request, reply) => {
        const result =
            await routeDependencies.mutateQualifiedConnectedServiceCredential({
            accountId: request.userId,
            ...request.body,
        });
        if (result.status === "storage_mode_mismatch") {
            return reply.code(400).send({ error: "invalid-params" });
        }
        if (result.status === "revision_required") {
            return reply.code(400).send({ error: "invalid-params" });
        }
        if (result.status === "provider_identity_mismatch") {
            return reply.code(409).send({
                error: "connect_reconnect_provider_identity_mismatch",
            });
        }
        if (result.status === "authentication_mode_mismatch") {
            return reply.code(409).send({
                error: "connect_authentication_mode_mismatch",
            });
        }
        if (result.status === "superseded") {
            return reply.code(409).send({
                error: "connect_credential_mutation_superseded",
                reason: result.reason,
                credentialRevision: result.credentialRevision,
                configurationRevision: result.configurationRevision,
            });
        }
        return reply.send({
            success: true,
            credentialRevision: result.credentialRevision,
            configurationRevision: result.configurationRevision,
        });
    });

    app.get("/v4/connect/qualified/credential", {
        preHandler: app.authenticate,
        schema: {
            querystring: StructuredRefQuerySchema,
            response: {
                200: QualifiedConnectedAccountCredentialSnapshotV4Schema,
                400: z.object({
                    error: z.literal("invalid-params"),
                }).strict(),
                404: z.object({
                    error: z.literal("connect_credential_not_found"),
                }).strict(),
                409: QualifiedConnectedAccountCredentialErrorV4Schema,
            },
        },
    }, async (request, reply) => {
        let ref;
        try {
            ref = parseQualifiedConnectedAccountV4StructuredQueryValue(
                QualifiedConnectedAccountRefSchema,
                request.query.ref,
            );
        } catch {
            return reply.code(400).send({ error: "invalid-params" });
        }
        const result =
            await routeDependencies.readQualifiedConnectedServiceCredential({
                accountId: request.userId,
                ref,
            });
        if (result.status === "not_found") {
            return reply.code(404).send({
                error: "connect_credential_not_found",
            });
        }
        if (result.status === "storage_mode_mismatch") {
            return reply.code(400).send({ error: "invalid-params" });
        }
        if (result.status === "unsupported_format") {
            return reply.code(409).send({
                error: "connect_credential_unsupported_format",
            });
        }
        return reply.send({ ref, ...result.credential });
    });

    app.get("/v4/connect/qualified/configuration", {
        preHandler: app.authenticate,
        schema: {
            querystring: StructuredConfigurationTargetQuerySchema,
            response: {
                200:
                    QualifiedConnectedAccountConfigurationSnapshotV4Schema,
                400: z.object({
                    error: z.literal("invalid-params"),
                }).strict(),
                404: z.object({
                    error: z.literal("connect_credential_not_found"),
                }).strict(),
            },
        },
    }, async (request, reply) => {
        let target;
        try {
            target = parseQualifiedConnectedAccountV4StructuredQueryValue(
                QualifiedConnectedAccountConfigurationTargetV4Schema,
                request.query.target,
            );
        } catch {
            return reply.code(400).send({ error: "invalid-params" });
        }
        const configuration =
            await routeDependencies.readQualifiedConnectedAccountConfiguration({
                accountId: request.userId,
                target,
            });
        if (!configuration) {
            return reply.code(404).send({
                error: "connect_credential_not_found",
            });
        }
        if ("status" in configuration) {
            return reply.code(400).send({ error: "invalid-params" });
        }
        return reply.send(configuration);
    });

    app.patch("/v4/connect/qualified/configuration", {
        preHandler: app.authenticate,
        schema: {
            body: QualifiedConnectedAccountConfigurationPatchV4Schema,
            response: {
                200:
                    QualifiedConnectedAccountCredentialMutationSuccessV4Schema,
                400: z.object({
                    error: z.literal("invalid-params"),
                }).strict(),
                404: z.object({
                    error: z.literal("connect_credential_not_found"),
                }).strict(),
                409: QualifiedConnectedAccountCredentialErrorV4Schema,
            },
        },
    }, async (request, reply) => {
        const result =
            await routeDependencies.mutateQualifiedConnectedAccountConfiguration({
                accountId: request.userId,
                target: request.body.target,
                expectedCredentialRevision:
                    request.body.expectedCredentialRevision,
                expectedConfigurationRevision:
                    request.body.expectedConfigurationRevision,
                replacementContentEnvelope:
                    request.body.replacementContentEnvelope,
                ...(request.body
                    .preserveConfigurationRevisionForCiphertextReseal
                    ? {
                        preserveConfigurationRevisionForCiphertextReseal:
                            true as const,
                    }
                    : {}),
            });
        if (
            result.status === "storage_mode_mismatch"
            || result.status === "revision_required"
        ) {
            return reply.code(400).send({ error: "invalid-params" });
        }
        if (result.status === "not_found") {
            return reply.code(404).send({
                error: "connect_credential_not_found",
            });
        }
        if (result.status === "superseded") {
            return reply.code(409).send({
                error: "connect_credential_mutation_superseded",
                reason: result.reason,
                credentialRevision: result.credentialRevision,
                configurationRevision: result.configurationRevision,
            });
        }
        return reply.send({
            success: true,
            credentialRevision: result.credentialRevision,
            configurationRevision: result.configurationRevision,
        });
    });

    app.patch("/v4/connect/qualified/credential/health", {
        preHandler: app.authenticate,
        schema: {
            body: QualifiedConnectedAccountCredentialHealthPatchV4Schema,
            response: {
                200:
                    QualifiedConnectedAccountCredentialMutationSuccessV4Schema,
                400: z.object({
                    error: z.literal("invalid-params"),
                }).strict(),
                404: z.object({
                    error: z.literal("connect_credential_not_found"),
                }).strict(),
                409: QualifiedConnectedAccountCredentialErrorV4Schema,
            },
        },
    }, async (request, reply) => {
        const result =
            await routeDependencies
                .mutateQualifiedConnectedServiceCredentialHealth({
                    accountId: request.userId,
                    ref: request.body.ref,
                    health: request.body.health,
                    expectedCredentialRevision:
                        request.body.expectedCredentialRevision,
                    expectedConfigurationRevision:
                        request.body.expectedConfigurationRevision,
                });
        if (
            result.status === "storage_mode_mismatch"
            || result.status === "revision_required"
        ) {
            return reply.code(400).send({ error: "invalid-params" });
        }
        if (result.status === "not_found") {
            return reply.code(404).send({
                error: "connect_credential_not_found",
            });
        }
        if (result.status === "unsupported_format") {
            return reply.code(409).send({
                error: "connect_credential_unsupported_format",
            });
        }
        if (result.status === "superseded") {
            return reply.code(409).send({
                error: "connect_credential_mutation_superseded",
                reason: result.reason,
                credentialRevision: result.credentialRevision,
                configurationRevision: result.configurationRevision,
            });
        }
        return reply.send({
            success: true,
            credentialRevision: result.credentialRevision,
            configurationRevision: result.configurationRevision,
        });
    });

    app.delete("/v4/connect/qualified/credential", {
        preHandler: app.authenticate,
        schema: {
            querystring: CredentialDeleteQuerySchema,
            response: {
                200: QualifiedConnectedAccountSuccessV4Schema,
                400: z.object({ error: z.literal("invalid-params") }).strict(),
                404: NotFoundResponseSchema,
                409: QualifiedConnectedAccountCredentialErrorV4Schema,
            },
        },
    }, async (request, reply) => {
        let ref;
        try {
            ref = parseQualifiedConnectedAccountV4StructuredQueryValue(
                QualifiedConnectedAccountRefSchema,
                request.query.ref,
            );
        } catch {
            return reply.code(400).send({ error: "invalid-params" });
        }
        const result = await deleteQualifiedConnectedServiceCredential({
            accountId: request.userId,
            ref,
            expectedCredentialRevision:
                request.query.expectedCredentialRevision,
            cleanupGroupReferences:
                request.query.cleanupGroupReferences === "true",
        });
        if (
            result.status === "storage_mode_mismatch"
            || result.status === "revision_required"
        ) {
            return reply.code(400).send({ error: "invalid-params" });
        }
        if (result.status === "not_found") {
            return reply.code(404).send({
                error: "connect_credential_not_found",
            });
        }
        if (result.status === "referenced") {
            return reply.code(409).send({
                error: "connect_credential_referenced_by_group",
            });
        }
        if (result.status === "superseded") {
            return reply.code(409).send({
                error: "connect_credential_mutation_superseded",
                reason: "credential_revision_mismatch",
                credentialRevision: result.credentialRevision,
                configurationRevision: result.configurationRevision,
            });
        }
        return reply.send({ success: true });
    });

    app.post("/v4/connect/qualified/credential/refresh-lease", {
        preHandler: app.authenticate,
        schema: {
            body: QualifiedConnectedAccountRefreshLeaseV4Schema,
            response: {
                200:
                    QualifiedConnectedAccountRefreshLeaseResponseV4Schema,
                400: z.object({ error: z.literal("invalid-params") }).strict(),
                404: NotFoundResponseSchema,
            },
        },
    }, async (request, reply) => {
        const result =
            await acquireQualifiedConnectedServiceRefreshLease({
                accountId: request.userId,
                ref: request.body.ref,
                ownerId: request.body.ownerId,
                ttlMs: request.body.ttlMs,
                expectedCredentialRevision:
                    request.body.expectedCredentialRevision,
            });
        if (result.status === "not_found") {
            return reply.code(404).send({
                error: "connect_credential_not_found",
            });
        }
        if (result.status === "revision_required") {
            return reply.code(400).send({ error: "invalid-params" });
        }
        return reply.send({
            acquired: result.acquired,
            leaseUntil: result.leaseUntil,
            ownerId: result.ownerId,
            credentialRevision: result.credentialRevision,
        });
    });

    app.get("/v4/connect/qualified/quotas", {
        preHandler: app.authenticate,
        schema: {
            querystring: StructuredRefQuerySchema,
            response: {
                200: QualifiedConnectedAccountQuotaResponseV4Schema,
                400: z.object({ error: z.literal("invalid-params") }).strict(),
                404: NotFoundResponseSchema,
            },
        },
    }, async (request, reply) => {
        let ref;
        try {
            ref = parseQualifiedConnectedAccountV4StructuredQueryValue(
                QualifiedConnectedAccountRefSchema,
                request.query.ref,
            );
        } catch {
            return reply.code(400).send({ error: "invalid-params" });
        }
        const quota = await readQualifiedConnectedAccountQuota({
            accountId: request.userId,
            ref,
        });
        if (!quota) {
            return reply.code(404).send({
                error: "connect_quotas_not_found",
            });
        }
        return reply.send(quota);
    });

    app.delete("/v4/connect/qualified/quotas", {
        preHandler: app.authenticate,
        schema: {
            querystring: StructuredRefQuerySchema,
            response: {
                200: QualifiedConnectedAccountSuccessV4Schema,
                400: z.object({ error: z.literal("invalid-params") }).strict(),
                404: NotFoundResponseSchema,
            },
        },
    }, async (request, reply) => {
        let ref;
        try {
            ref = parseQualifiedConnectedAccountV4StructuredQueryValue(
                QualifiedConnectedAccountRefSchema,
                request.query.ref,
            );
        } catch {
            return reply.code(400).send({ error: "invalid-params" });
        }
        const result = await unlinkQualifiedConnectedAccountQuota({
            accountId: request.userId,
            ref,
        });
        if (result === "not_found") {
            return reply.code(404).send({
                error: "connect_quotas_not_found",
            });
        }
        return reply.send({ success: true });
    });

    app.post("/v4/connect/qualified/quotas/refresh", {
        preHandler: app.authenticate,
        schema: {
            body: QualifiedConnectedAccountQuotaQueryV4Schema,
            response: {
                200: QualifiedConnectedAccountSuccessV4Schema,
                404: NotFoundResponseSchema,
            },
        },
    }, async (request, reply) => {
        const result =
            await requestQualifiedConnectedAccountQuotaRefresh({
                accountId: request.userId,
                ref: request.body.ref,
            });
        if (result === "not_found") {
            return reply.code(404).send({
                error: "connect_quotas_not_found",
            });
        }
        return reply.send({ success: true });
    });

    app.get("/v4/connect/qualified/groups", {
        preHandler: app.authenticate,
        schema: {
            querystring: StructuredServiceQuerySchema,
            response: {
                200: QualifiedConnectedAccountGroupListResponseV4Schema,
                400: z.object({ error: z.literal("invalid-params") }).strict(),
            },
        },
    }, async (request, reply) => {
        let service;
        try {
            service = parseQualifiedConnectedAccountV4StructuredQueryValue(
                QualifiedConnectedAccountServiceRefSchema,
                request.query.service,
            );
        } catch {
            return reply.code(400).send({ error: "invalid-params" });
        }
        return reply.send({
            groups: await listQualifiedConnectedAccountGroups({
                accountId: request.userId,
                service,
            }),
        });
    });

    app.post("/v4/connect/qualified/groups", {
        preHandler: app.authenticate,
        schema: {
            body: QualifiedConnectedAccountGroupCreateV4Schema,
            response: {
                200: QualifiedConnectedAccountGroupResponseV4Schema,
                409: GroupConflictResponseSchema,
            },
        },
    }, async (request, reply) => {
        const result = await createQualifiedConnectedAccountGroup({
            accountId: request.userId,
            ...request.body,
            legacyV3Mutation: false,
        });
        if (result.status === "already_exists") {
            return reply.code(409).send({
                error: "connect_group_already_exists",
            });
        }
        if (result.status === "source_superseded") {
            return reply.code(409).send({
                error: "connect_group_source_revision_conflict",
            });
        }
        if (result.status !== "written") {
            return reply.code(409).send({
                error: "connect_group_runtime_state_revision_conflict",
                runtimeStateRevision:
                    result.status === "superseded"
                        ? result.runtimeStateRevision
                        : null,
            });
        }
        return reply.send({ group: result.group });
    });

    app.get("/v4/connect/qualified/group", {
        preHandler: app.authenticate,
        schema: {
            querystring: StructuredGroupQuerySchema,
            response: {
                200: QualifiedConnectedAccountGroupResponseV4Schema,
                400: z.object({ error: z.literal("invalid-params") }).strict(),
                404: NotFoundResponseSchema,
                409: GroupConflictResponseSchema,
            },
        },
    }, async (request, reply) => {
        let group;
        let expectedRuntimeStateRevision;
        try {
            group = parseQualifiedConnectedAccountV4StructuredQueryValue(
                QualifiedConnectedAccountGroupRefSchema,
                request.query.group,
            );
            expectedRuntimeStateRevision = parseOptionalCanonicalInteger(
                request.query.expectedRuntimeStateRevision,
            );
        } catch {
            return reply.code(400).send({ error: "invalid-params" });
        }
        const stored = await readQualifiedConnectedAccountGroup({
            accountId: request.userId,
            service: group.service,
            groupId: group.groupId,
        });
        if (!stored) {
            return reply.code(404).send({
                error: "connect_group_not_found",
            });
        }
        if (
            expectedRuntimeStateRevision !== undefined
            && expectedRuntimeStateRevision
                !== stored.runtimeStateRevision
        ) {
            return reply.code(409).send({
                error: "connect_group_runtime_state_revision_conflict",
                runtimeStateRevision: stored.runtimeStateRevision,
            });
        }
        return reply.send({ group: stored });
    });

    app.patch("/v4/connect/qualified/group", {
        preHandler: app.authenticate,
        schema: {
            body: QualifiedConnectedAccountGroupPatchV4Schema,
            response: {
                200: QualifiedConnectedAccountGroupResponseV4Schema,
                404: NotFoundResponseSchema,
                409: GroupConflictResponseSchema,
            },
        },
    }, async (request, reply) => {
        const result = await patchQualifiedConnectedAccountGroup({
            accountId: request.userId,
            patch: request.body,
            expectedIncarnation:
                request.body.expectedIncarnation ?? null,
        });
        if (result.status === "not_found") {
            return reply.code(404).send({
                error: "connect_group_not_found",
            });
        }
        if (result.status === "incarnation_superseded") {
            return reply.code(409).send({
                error: "connect_group_incarnation_conflict",
            });
        }
        if (result.status === "member_not_found"
            || result.status === "member_disabled") {
            return reply.code(409).send({
                error: "connect_group_active_profile_not_member",
            });
        }
        if (result.status === "source_superseded") {
            return reply.code(409).send({
                error: "connect_group_source_revision_conflict",
            });
        }
        if (result.status !== "written") {
            return reply.code(409).send({
                error: "connect_group_runtime_state_revision_conflict",
                runtimeStateRevision:
                    result.status === "superseded"
                        ? result.runtimeStateRevision
                        : null,
            });
        }
        return reply.send({ group: result.group });
    });

    app.delete("/v4/connect/qualified/group", {
        preHandler: app.authenticate,
        schema: {
            querystring: StructuredGroupDeleteQuerySchema,
            response: {
                200: QualifiedConnectedAccountSuccessV4Schema,
                400: z.object({ error: z.literal("invalid-params") }).strict(),
                404: NotFoundResponseSchema,
                409: GroupConflictResponseSchema,
            },
        },
    }, async (request, reply) => {
        let group;
        let expectedRuntimeStateRevision;
        let expectedIncarnation;
        try {
            group = parseQualifiedConnectedAccountV4StructuredQueryValue(
                QualifiedConnectedAccountGroupRefSchema,
                request.query.group,
            );
            expectedRuntimeStateRevision = parseOptionalCanonicalInteger(
                request.query.expectedRuntimeStateRevision,
            );
            expectedIncarnation = parseOptionalQualifiedGroupIncarnation(
                request.query.expectedIncarnation,
            );
        } catch {
            return reply.code(400).send({ error: "invalid-params" });
        }
        const result = await deleteQualifiedConnectedAccountGroup({
            accountId: request.userId,
            service: group.service,
            groupId: group.groupId,
            ...(expectedRuntimeStateRevision !== undefined
                ? { expectedRuntimeStateRevision }
                : {}),
            expectedIncarnation: expectedIncarnation ?? null,
        });
        if (result.status === "not_found") {
            return reply.code(404).send({
                error: "connect_group_not_found",
            });
        }
        if (result.status === "superseded") {
            return reply.code(409).send({
                error: "connect_group_runtime_state_revision_conflict",
                runtimeStateRevision: result.runtimeStateRevision,
            });
        }
        if (result.status === "incarnation_superseded") {
            return reply.code(409).send({
                error: "connect_group_incarnation_conflict",
            });
        }
        return reply.send({ success: true });
    });

    app.patch("/v4/connect/qualified/group/runtime-state", {
        preHandler: app.authenticate,
        schema: {
            body: QualifiedConnectedAccountGroupRuntimeStatePatchV4Schema,
            response: {
                200: QualifiedConnectedAccountGroupResponseV4Schema,
                404: NotFoundResponseSchema,
                409: GroupConflictResponseSchema,
            },
        },
    }, async (request, reply) => {
        const result =
            await patchQualifiedConnectedAccountGroupRuntimeState({
                accountId: request.userId,
                patch: request.body,
                expectedIncarnation:
                    request.body.expectedIncarnation ?? null,
            });
        if (result.status === "not_found") {
            return reply.code(404).send({
                error: "connect_group_not_found",
            });
        }
        if (result.status === "member_not_found") {
            return reply.code(409).send({
                error: "connect_group_member_not_found",
            });
        }
        if (result.status === "incarnation_superseded") {
            return reply.code(409).send({
                error: "connect_group_incarnation_conflict",
            });
        }
        if (result.status !== "written") {
            return reply.code(409).send({
                error: "connect_group_runtime_state_revision_conflict",
                runtimeStateRevision:
                    result.status === "superseded"
                        ? result.runtimeStateRevision
                        : null,
            });
        }
        return reply.send({ group: result.group });
    });

    app.post("/v4/connect/qualified/group/members", {
        preHandler: app.authenticate,
        schema: {
            body: QualifiedConnectedAccountGroupMemberMutationV4Schema,
            response: {
                200: QualifiedConnectedAccountGroupResponseV4Schema,
                404: NotFoundResponseSchema,
                409: GroupConflictResponseSchema,
            },
        },
    }, async (request, reply) => {
        const result =
            await createQualifiedConnectedAccountGroupMember({
                accountId: request.userId,
                mutation: request.body,
                expectedIncarnation:
                    request.body.expectedIncarnation ?? null,
            });
        if (result.status === "not_found") {
            return reply.code(404).send({
                error: "connect_group_not_found",
            });
        }
        if (result.status === "already_exists") {
            return reply.code(409).send({
                error: "connect_group_member_already_exists",
            });
        }
        if (result.status === "member_not_found") {
            return reply.code(409).send({
                error: "connect_group_member_not_found",
            });
        }
        if (result.status === "incarnation_superseded") {
            return reply.code(409).send({
                error: "connect_group_incarnation_conflict",
            });
        }
        if (result.status === "source_superseded") {
            return reply.code(409).send({
                error: "connect_group_source_revision_conflict",
            });
        }
        if (result.status !== "written") {
            return reply.code(409).send({
                error: "connect_group_runtime_state_revision_conflict",
                runtimeStateRevision:
                    result.status === "superseded"
                        ? result.runtimeStateRevision
                        : null,
            });
        }
        return reply.send({ group: result.group });
    });

    app.patch("/v4/connect/qualified/group/member", {
        preHandler: app.authenticate,
        schema: {
            body: QualifiedConnectedAccountGroupMemberMutationV4Schema,
            response: {
                200: QualifiedConnectedAccountGroupResponseV4Schema,
                404: NotFoundResponseSchema,
                409: GroupConflictResponseSchema,
            },
        },
    }, async (request, reply) => {
        const result =
            await updateQualifiedConnectedAccountGroupMember({
                accountId: request.userId,
                mutation: request.body,
                expectedIncarnation:
                    request.body.expectedIncarnation ?? null,
            });
        if (result.status === "not_found") {
            return reply.code(404).send({
                error: "connect_group_not_found",
            });
        }
        if (result.status === "member_not_found") {
            return reply.code(409).send({
                error: "connect_group_member_not_found",
            });
        }
        if (result.status === "incarnation_superseded") {
            return reply.code(409).send({
                error: "connect_group_incarnation_conflict",
            });
        }
        if (result.status !== "written") {
            return reply.code(409).send({
                error: "connect_group_runtime_state_revision_conflict",
                runtimeStateRevision:
                    result.status === "superseded"
                        ? result.runtimeStateRevision
                        : null,
            });
        }
        return reply.send({ group: result.group });
    });

    app.delete("/v4/connect/qualified/group/member", {
        preHandler: app.authenticate,
        schema: {
            querystring: StructuredGroupMemberDeleteQuerySchema,
            response: {
                200: QualifiedConnectedAccountGroupResponseV4Schema,
                400: z.object({ error: z.literal("invalid-params") }).strict(),
                404: NotFoundResponseSchema,
                409: GroupConflictResponseSchema,
            },
        },
    }, async (request, reply) => {
        let mutation;
        try {
            mutation = parseQualifiedConnectedAccountV4StructuredQueryValue(
                QualifiedConnectedAccountGroupMemberDeleteV4Schema,
                request.query.mutation,
            );
        } catch {
            return reply.code(400).send({ error: "invalid-params" });
        }
        const result =
            await deleteQualifiedConnectedAccountGroupMember({
                accountId: request.userId,
                mutation,
                expectedIncarnation:
                    mutation.expectedIncarnation ?? null,
            });
        if (result.status === "not_found") {
            return reply.code(404).send({
                error: "connect_group_not_found",
            });
        }
        if (result.status === "member_not_found") {
            return reply.code(409).send({
                error: "connect_group_member_not_found",
            });
        }
        if (result.status === "incarnation_superseded") {
            return reply.code(409).send({
                error: "connect_group_incarnation_conflict",
            });
        }
        if (result.status !== "written") {
            return reply.code(409).send({
                error: "connect_group_runtime_state_revision_conflict",
                runtimeStateRevision:
                    result.status === "superseded"
                        ? result.runtimeStateRevision
                        : null,
            });
        }
        return reply.send({ group: result.group });
    });

    app.post("/v4/connect/qualified/group/active-account", {
        preHandler: app.authenticate,
        schema: {
            body: QualifiedConnectedAccountGroupActiveAccountV4Schema,
            response: {
                200: QualifiedConnectedAccountGroupResponseV4Schema,
                404: NotFoundResponseSchema,
                409: GroupConflictResponseSchema,
            },
        },
    }, async (request, reply) => {
        const result =
            await setQualifiedConnectedAccountGroupActiveAccount({
                accountId: request.userId,
                mutation: request.body,
                expectedIncarnation:
                    request.body.expectedIncarnation ?? null,
            });
        if (result.status === "not_found") {
            return reply.code(404).send({
                error: "connect_group_not_found",
            });
        }
        if (
            result.status === "member_not_found"
            || result.status === "member_disabled"
        ) {
            return reply.code(409).send({
                error: "connect_group_active_profile_not_member",
            });
        }
        if (result.status === "incarnation_superseded") {
            return reply.code(409).send({
                error: "connect_group_incarnation_conflict",
            });
        }
        if (result.status === "generation_superseded") {
            return reply.code(409).send({
                error: "connect_group_generation_conflict",
                generation: result.generation,
            });
        }
        if (result.status === "source_superseded") {
            return reply.code(409).send({
                error: "connect_group_source_revision_conflict",
            });
        }
        if (result.status === "runtime_cooldown") {
            return reply.code(409).send({
                error: "connect_group_profile_runtime_cooldown",
                ...(result.resetAtMs !== undefined
                    ? { resetAtMs: result.resetAtMs }
                    : {}),
            });
        }
        if (result.status !== "written") {
            return reply.code(409).send({
                error: "connect_group_runtime_state_revision_conflict",
                runtimeStateRevision:
                    result.status === "superseded"
                        ? result.runtimeStateRevision
                        : null,
            });
        }
        return reply.send({ group: result.group });
    });

    app.get(
        "/v4/connect/qualified/provider-account-usage/sources/resolve",
        {
            preHandler: app.authenticate,
            schema: {
                querystring: StructuredUsageSourceQuerySchema,
                response: {
                    200:
                        QualifiedConnectedServiceUsageSourceResolutionV4Schema,
                    400: z.object({
                        error: z.literal("invalid-params"),
                    }).strict(),
                    404: NotFoundResponseSchema,
                },
            },
        },
        async (request, reply) => {
            let source;
            try {
                source =
                    parseQualifiedConnectedAccountV4StructuredQueryValue(
                        QualifiedConnectedServiceUsageSourceV4Schema,
                        request.query.source,
                    );
            } catch {
                return reply.code(400).send({
                    error: "invalid-params",
                });
            }
            const resolved =
                await readExactQualifiedConnectedServiceUsageSource({
                    accountId: request.userId,
                    source,
                });
            if (!resolved) {
                return reply.code(404).send({
                    error:
                        "provider_account_usage_source_not_found",
                });
            }
            return reply.send(resolved);
        },
    );

    app.post("/v4/connect/qualified/provider-account-usage", {
        preHandler: app.authenticate,
        schema: {
            body: QualifiedProviderAccountUsageWriteV4Schema,
            response: {
                200: QualifiedProviderAccountUsageWriteSuccessV4Schema,
                400: z.object({ error: z.literal("invalid-params") }).strict(),
                409: QualifiedConnectedAccountCredentialErrorV4Schema,
            },
        },
    }, async (request, reply) => {
        const {
            source,
            expectedCredentialRevision,
            expectedConfigurationRevision,
            metadata,
            refreshRequestedAt: _refreshRequestedAt,
            ...write
        } = request.body;
        if (
            write.status === "refresh_requested"
            || write.fetchedAt === undefined
            || write.staleAfterMs === undefined
        ) {
            return reply.code(400).send({ error: "invalid-params" });
        }
        try {
            const result =
                await writeQualifiedProviderAccountUsageRecord({
                    accountId: request.userId,
                    source,
                    expectedCredentialRevision,
                    expectedConfigurationRevision,
                    recordId: write.recordId,
                    recordKey: write.recordKey,
                    payloadMode: write.payloadMode,
                    status: write.status,
                    fetchedAt: write.fetchedAt,
                    staleAfterMs: write.staleAfterMs,
                    ...(write.snapshot
                        ? { snapshot: write.snapshot }
                        : {}),
                    ...(write.sealedPayload
                        ? { sealedPayload: write.sealedPayload }
                        : {}),
                    ...(metadata?.materialFingerprint
                        ? {
                            materialFingerprint:
                                metadata.materialFingerprint,
                        }
                        : {}),
                });
            return reply.send({
                success: true,
                source: result.sourceOutcome,
            });
        } catch (error) {
            if (
                error instanceof
                    QualifiedConnectedAccountUsageBasisError
            ) {
                return reply.code(409).send({
                    error: "connect_credential_mutation_superseded",
                    reason: error.reason,
                    credentialRevision: error.credentialRevision,
                    configurationRevision:
                        error.configurationRevision,
                });
            }
            if (
                error instanceof
                    ConnectedServiceUsageSourceBindingError
                || error instanceof
                    ConnectedServiceUsageSourceOwnershipError
                || error instanceof
                    ProviderAccountUsagePayloadInvariantError
            ) {
                return reply.code(400).send({
                    error: "invalid-params",
                });
            }
            throw error;
        }
    });

    app.get(
        "/v4/connect/qualified/provider-account-usage/record",
        {
            preHandler: app.authenticate,
            schema: {
                querystring: ProviderUsageRecordQuerySchema,
                response: {
                    200:
                        QualifiedProviderAccountUsageRecordResponseV4Schema,
                    404: NotFoundResponseSchema,
                },
            },
        },
        async (request, reply) => {
            const qualifiedRecord =
                await readQualifiedProviderAccountUsageRecord({
                accountId: request.userId,
                recordId: request.query.recordId,
            });
            const record = qualifiedRecord?.record;
            if (
                !record
                || (
                    record.payloadMode === "plain_json_v1"
                    && !record.snapshot
                )
                || (
                    record.payloadMode
                        === "sealed_account_scoped_v1"
                    && !record.sealedPayload
                )
            ) {
                return reply.code(404).send({
                    error: "provider_account_usage_not_found",
                });
            }
            const fallbackFetchedAt =
                record.snapshot?.fetchedAtMs ?? 0;
            const fallbackStaleAfterMs =
                record.snapshot?.staleAfterMs ?? 0;
            return reply.send({
                content:
                    record.payloadMode === "plain_json_v1"
                        ? {
                            t: "plain",
                            v: record.snapshot!,
                        }
                        : {
                            t: "encrypted",
                            c: record.sealedPayload!.ciphertext,
                        },
                metadata: {
                    fetchedAt:
                        record.fetchedAt ?? fallbackFetchedAt,
                    staleAfterMs:
                        record.staleAfterMs
                        ?? fallbackStaleAfterMs,
                    status:
                        record.status === "unavailable"
                        || record.status === "estimated"
                        || record.status === "error"
                            ? record.status
                            : "ok",
                    ...(record.refreshRequestedAt !== undefined
                        ? {
                            refreshRequestedAt:
                                record.refreshRequestedAt,
                        }
                        : {}),
                },
                sources: qualifiedRecord.sources,
            });
        },
    );

    app.delete(
        "/v4/connect/qualified/provider-account-usage/record",
        {
            preHandler: app.authenticate,
            schema: {
                querystring: ProviderUsageRecordQuerySchema,
                response: {
                    200: QualifiedConnectedAccountSuccessV4Schema,
                    404: NotFoundResponseSchema,
                },
            },
        },
        async (request, reply) => {
            const result =
                await deleteQualifiedProviderAccountUsageRecord({
                accountId: request.userId,
                recordId: request.query.recordId,
            });
            if (result === "not_found") {
                return reply.code(404).send({
                    error: "provider_account_usage_not_found",
                });
            }
            return reply.send({ success: true });
        },
    );

    app.post(
        "/v4/connect/qualified/provider-account-usage/record/refresh",
        {
            preHandler: app.authenticate,
            schema: {
                body: QualifiedProviderAccountUsageRecordQueryV4Schema,
                response: {
                    200: QualifiedConnectedAccountSuccessV4Schema,
                    404: NotFoundResponseSchema,
                },
            },
        },
        async (request, reply) => {
            const result =
                await requestQualifiedProviderAccountUsageRefresh({
                accountId: request.userId,
                recordId: request.body.recordId,
            });
            if (result === "not_found") {
                return reply.code(404).send({
                    error: "provider_account_usage_not_found",
                });
            }
            return reply.send({ success: true });
        },
    );
}
