import { z } from "zod/mini";
import type { Fastify } from "../../../types";
import { CONNECTED_SERVICE_ERROR_CODES } from '@happier-dev/protocol/connect/connectedServiceErrors';
import { ConnectedServiceCredentialMutationSupersededV1Schema, ConnectedServiceCredentialHealthV1Schema, ConnectedServiceCredentialRecordV1Schema } from '@happier-dev/protocol/connect/connected-service-schemas';
import { ConnectedServiceIdSchema, type ConnectedServiceId } from '@happier-dev/protocol/connect/connected-service-bindings';
import { StoredJsonContentEnvelopeSchema } from '@happier-dev/protocol/storage/storedJsonContentEnvelope';
import { assertConnectedServiceCredentialRecordBinding } from '@happier-dev/protocol/connect/connectedServiceCredentialBinding';
import { projectBuiltInLegacyConnectedServiceCredentialRecordV1 } from '@happier-dev/protocol/connect/legacyConnectedServiceCompatibility';
import { ConnectedServiceProfileIdSchema } from "../connectedServicesV2/profileIdSchema";
import {
    isConnectedServiceCredentialMetadataV3,
    normalizeConnectedServiceCredentialMetadataV3,
} from "./credentialMetadataV3";
import { NotFoundSchema } from "../../../schemas/notFoundSchema";
import { isServerFeatureEnabledForRequest } from "@/app/features/catalog/serverFeatureGate";
import {
    mutateConnectedServiceCredential,
    mutateConnectedServiceCredentialHealth,
} from "../credentials/mutation";
import {
    connectedServiceCredentialMutationGuardFields,
    validateConnectedServiceCredentialMutationGuard,
} from "../credentials/mutationGuardSchema";
import { ConnectedServiceCredentialDeleteQuerySchema } from "../credentials/credentialDeleteQuerySchema";
import {
    deleteQualifiedConnectedServiceCredentialForStorageMode,
    readQualifiedConnectedServiceCredentialForLegacyProjection,
} from "../qualifiedConnectedAccounts/credentialRepository";
import {
    resolveLegacyQualifiedConnectedAccountService,
} from "../qualifiedConnectedAccounts/identity";
import {
    ConnectedServiceCredentialV3PreparationError,
    prepareConnectedServiceCredentialMutationV3,
} from "./prepareConnectedServiceCredentialMutationV3";
import { readRequestHomeEnv } from "@/app/home/settings/requestHomeEnv";

export function registerConnectedServiceCredentialRoutesV3(app: Fastify): void {
    app.post("/v3/connect/:serviceId/profiles/:profileId/credential", {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                serviceId: ConnectedServiceIdSchema,
                profileId: ConnectedServiceProfileIdSchema,
            }),
            body: z.strictObject({
                content: StoredJsonContentEnvelopeSchema,
                reconnect: z.optional(z.object({
                    allowProviderIdentityChange: z._default(z.optional(z.boolean()), false),
                })),
                ...connectedServiceCredentialMutationGuardFields,
            }).check(z.superRefine(validateConnectedServiceCredentialMutationGuard)),
            response: {
                200: z.object({ success: z.literal(true), credentialRevision: z.string() }),
                400: z.union([
                    z.object({ error: z.literal("invalid-params") }),
                    z.object({ error: z.literal(CONNECTED_SERVICE_ERROR_CODES.credentialInvalid) }),
                ]),
                409: z.union([
                    z.object({ error: z.literal(CONNECTED_SERVICE_ERROR_CODES.reconnectProviderIdentityMismatch) }),
                    z.object({
                        error: z.literal(CONNECTED_SERVICE_ERROR_CODES.credentialMutationSuperseded),
                        reason: z.enum(["revision_mismatch", "refresh_lease_lost"]),
                        credentialRevision: z.nullable(z.string()),
                    }),
                    z.object({ error: z.literal("connect_credential_unsupported_format") }),
                ]),
            },
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const serviceId = request.params.serviceId satisfies ConnectedServiceId;
        const profileId = request.params.profileId;

        const content = request.body.content;
        if (content.t !== "plain") {
            return reply.code(400).send({ error: "invalid-params" });
        }
        if (request.body.expectedCredentialRevision === undefined) {
            return reply.code(400).send({ error: "invalid-params" });
        }

        let prepared:
            ReturnType<
                typeof prepareConnectedServiceCredentialMutationV3
            >;
        try {
            prepared = prepareConnectedServiceCredentialMutationV3({
                accountId: userId,
                serviceId,
                profileId,
                record: content.v,
            });
        } catch (error) {
            if (
                error
                    instanceof
                    ConnectedServiceCredentialV3PreparationError
                && error.reason === "invalid_binding"
            ) {
                return reply.code(400).send({
                    error:
                        CONNECTED_SERVICE_ERROR_CODES.credentialInvalid,
                });
            }
            return reply.code(400).send({ error: "invalid-params" });
        }

        const result = await mutateConnectedServiceCredential({
            accountId: userId,
            serviceId,
            profileId,
            token: prepared.token,
            metadata: prepared.metadata,
            expiresAt: prepared.expiresAt,
            storageMode: "plain",
            incomingIdentity: prepared.incomingIdentity,
            allowProviderIdentityChange: request.body.reconnect?.allowProviderIdentityChange === true,
            ...(request.body.expectedCredentialRevision !== undefined
                ? { expectedCredentialRevision: request.body.expectedCredentialRevision }
                : {}),
            ...(request.body.refreshLeaseOwnerId ? { refreshLeaseOwnerId: request.body.refreshLeaseOwnerId } : {}),
        });
        if (result.status === "provider_identity_mismatch") {
            return reply.code(409).send({ error: CONNECTED_SERVICE_ERROR_CODES.reconnectProviderIdentityMismatch });
        }
        if (result.status === "unsupported_format") {
            return reply.code(409).send({ error: "connect_credential_unsupported_format" });
        }
        if (
            result.status === "storage_mode_mismatch"
            || result.status === "revision_required"
        ) {
            return reply.code(400).send({ error: "invalid-params" });
        }
        if (result.status === "superseded") {
            return reply.code(409).send({
                error: CONNECTED_SERVICE_ERROR_CODES.credentialMutationSuperseded,
                reason: result.reason,
                credentialRevision: result.credentialRevision,
            });
        }

        return reply.send({ success: true, credentialRevision: result.credentialRevision });
    });

    app.patch("/v3/connect/:serviceId/profiles/:profileId/credential/health", {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                serviceId: ConnectedServiceIdSchema,
                profileId: ConnectedServiceProfileIdSchema,
            }),
            body: z.strictObject({
                health: ConnectedServiceCredentialHealthV1Schema,
                expectedCredentialRevision: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(128))),
            }),
            response: {
                200: z.object({ success: z.literal(true), credentialRevision: z.string() }),
                400: z.strictObject({ error: z.literal("invalid-params") }),
                404: z.union([NotFoundSchema, z.object({ error: z.literal("connect_credential_not_found") })]),
                409: z.union([
                    z.object({ error: z.literal("connect_credential_unsupported_format") }),
                    z.object({
                        error: z.literal(CONNECTED_SERVICE_ERROR_CODES.credentialMutationSuperseded),
                        reason: z.literal("revision_mismatch"),
                        credentialRevision: z.string(),
                    }),
                ]),
            },
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const serviceId = request.params.serviceId satisfies ConnectedServiceId;
        const profileId = request.params.profileId;

        const result = await mutateConnectedServiceCredentialHealth({
            accountId: userId,
            serviceId,
            profileId,
            health: request.body.health,
            ...(request.body.expectedCredentialRevision ? { expectedCredentialRevision: request.body.expectedCredentialRevision } : {}),
        });
        if (result.status === "not_found") return reply.code(404).send({ error: "connect_credential_not_found" });
        if (
            result.status === "storage_mode_mismatch"
            || result.status === "revision_required"
        ) {
            return reply.code(400).send({ error: "invalid-params" });
        }
        if (result.status === "unsupported_format") {
            return reply.code(409).send({ error: "connect_credential_unsupported_format" });
        }
        if (result.status === "superseded") {
            return reply.code(409).send({
                error: CONNECTED_SERVICE_ERROR_CODES.credentialMutationSuperseded,
                reason: result.reason,
                credentialRevision: result.credentialRevision,
            });
        }

        return reply.send({ success: true, credentialRevision: result.credentialRevision });
    });

    app.get("/v3/connect/:serviceId/profiles/:profileId/credential", {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                serviceId: ConnectedServiceIdSchema,
                profileId: ConnectedServiceProfileIdSchema,
            }),
            response: {
                200: z.object({
                    credentialRevision: z.optional(z.string()),
                    content: StoredJsonContentEnvelopeSchema,
                }),
                404: z.union([NotFoundSchema, z.object({ error: z.literal("connect_credential_not_found") })]),
                409: z.object({ error: z.literal("connect_credential_unsupported_format") }),
            },
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const serviceId = request.params.serviceId satisfies ConnectedServiceId;
        const profileId = request.params.profileId;

        const result =
            await readQualifiedConnectedServiceCredentialForLegacyProjection({
                accountId: userId,
                ref: {
                    service:
                        resolveLegacyQualifiedConnectedAccountService(
                            serviceId,
                        ),
                    accountId: profileId,
                },
            });
        if (result.status !== "resolved") {
            if (
                result.status === "not_found"
                || result.status === "storage_mode_mismatch"
            ) {
                return reply.code(404).send({
                    error: "connect_credential_not_found",
                });
            }
            return reply.code(409).send({
                error: "connect_credential_unsupported_format",
            });
        }
        const snapshot = result.credential;
        if (snapshot.content.t !== "plain") {
            return reply.code(404).send({
                error: "connect_credential_not_found",
            });
        }
        const record =
            ConnectedServiceCredentialRecordV1Schema.safeParse(
                snapshot.content.v,
            );
        if (!record.success) {
            return reply.code(409).send({ error: "connect_credential_unsupported_format" });
        }
        try {
            assertConnectedServiceCredentialRecordBinding({
                binding: { serviceId, profileId },
                record: record.data,
            });
        } catch {
            return reply.code(409).send({ error: "connect_credential_unsupported_format" });
        }
        const response = {
            content: {
                t: "plain" as const,
                v:
                    projectBuiltInLegacyConnectedServiceCredentialRecordV1(
                        record.data,
                    ),
            },
        };
        return snapshot.revisionSemantics === "revisioned"
            && snapshot.credentialRevision !== null
            ? reply.send({
                ...response,
                credentialRevision: snapshot.credentialRevision,
            })
            : reply.send(response);
    });

    app.delete("/v3/connect/:serviceId/profiles/:profileId/credential", {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                serviceId: ConnectedServiceIdSchema,
                profileId: ConnectedServiceProfileIdSchema,
            }),
            querystring: ConnectedServiceCredentialDeleteQuerySchema,
            response: {
                200: z.object({ success: z.literal(true) }),
                400: z.strictObject({ error: z.literal("invalid-params") }),
                404: z.union([NotFoundSchema, z.object({ error: z.literal("connect_credential_not_found") })]),
                409: z.union([
                    z.object({ error: z.literal("connect_credential_referenced_by_group") }),
                    ConnectedServiceCredentialMutationSupersededV1Schema,
                ]),
            },
        },
    }, async (request, reply) => {
        const requestHomeEnv = await readRequestHomeEnv(request);
        const userId = request.userId;
        const serviceId = request.params.serviceId satisfies ConnectedServiceId;
        const profileId = request.params.profileId;

        const result =
            await deleteQualifiedConnectedServiceCredentialForStorageMode({
                accountId: userId,
                ref: {
                    service:
                        resolveLegacyQualifiedConnectedAccountService(
                            serviceId,
                        ),
                    accountId: profileId,
                },
                expectedStorageMode: "plain",
                ...(request.query.expectedCredentialRevision
                    ? { expectedCredentialRevision: request.query.expectedCredentialRevision }
                    : {}),
                cleanupGroupReferences: request.query.cleanupGroupReferences === true
                    || !isServerFeatureEnabledForRequest("connectedServices.accountGroups", requestHomeEnv),
            });
        if (result.status === "revision_required") {
            return reply.code(400).send({ error: "invalid-params" });
        }
        if (result.status === "storage_mode_mismatch") {
            return reply.code(404).send({ error: "connect_credential_not_found" });
        }
        if (result.status === "not_found") return reply.code(404).send({ error: "connect_credential_not_found" });
        if (result.status === "referenced") {
            return reply.code(409).send({ error: "connect_credential_referenced_by_group" });
        }
        if (result.status === "superseded") {
            return reply.code(409).send({
                error: CONNECTED_SERVICE_ERROR_CODES.credentialMutationSuperseded,
                reason: "revision_mismatch",
                credentialRevision: result.credentialRevision,
            });
        }

        return reply.send({ success: true });
    });
}
