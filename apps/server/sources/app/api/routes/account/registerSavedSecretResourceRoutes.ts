import { decodeBase64, encodeBase64 } from "privacy-kit";
import { z } from "zod";

import {
    SavedSecretResourceActionErrorV1Schema,
    SavedSecretResourceMaterialsResponseV1Schema,
    SavedSecretResourceEnvelopeCensusRequestV1Schema,
    SavedSecretResourceEnvelopeCensusResponseV1Schema,
    SavedSecretResourceEnvelopeRepairInputV1Schema,
    SavedSecretResourceEnvelopeRepairOutputV1Schema,
    SavedSecretResourceRecipientEnvelopeInputV1Schema,
    SharedSavedSecretCreateInputV1Schema,
    SharedSavedSecretDeleteInputV1Schema,
    SharedSavedSecretDeleteOutputV1Schema,
    SharedSavedSecretGrantsSetInputV1Schema,
    SharedSavedSecretListOutputV1Schema,
    SharedSavedSecretMutationOutputV1Schema,
    SharedSavedSecretPromoteInputV1Schema,
    SharedSavedSecretPromoteOutputV1Schema,
    SharedSavedSecretUpdateInputV1Schema,
} from "@happier-dev/protocol";
import { inTx } from "@/storage/inTx";
import { type Fastify } from "../../types";
import { requirePresentUser, PresentUserRequiredResponseSchema } from "@/app/api/utils/requirePresentUser";
import {
    createSavedSecretResourceInTx,
    deleteSavedSecretResourceInTx,
    listSavedSecretResourceMaterialsForAccountInTx,
    listSavedSecretResourceEnvelopeCensusInTx,
    listSavedSecretResourcesForAccountInTx,
    promoteSavedSecretResourceInTx,
    repairSavedSecretResourceKeyEnvelopesInTx,
    SavedSecretResourceTransactionAbort,
    setSavedSecretResourceGrantsInTx,
    updateSavedSecretResourceInTx,
} from "@/app/account/savedSecrets/savedSecretResourceService";
import { homeDomainActionPathForMethod } from "@/app/api/routes/actions/homeDomainActionRoute";
import { createTeamRouteApp } from "@/app/teams/teamRouteApp";
import { readTeamOperationAuthenticationFromRequest } from "@/app/teams/actorContext";

function copyBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return copy;
}

function decodeEnvelopeBytes(value: string): Uint8Array<ArrayBuffer> | null {
    try {
        return copyBytes(decodeBase64(value, "base64"));
    } catch {
        return null;
    }
}

function decodeEnvelopes(
    envelopes: readonly z.infer<typeof SavedSecretResourceRecipientEnvelopeInputV1Schema>[] | undefined,
): ReadonlyArray<{
    recipientAccountId: string;
    encryptedDataKey: Uint8Array<ArrayBuffer>;
    recipientContentPublicKeyFingerprint: string;
}> | null {
    if (!envelopes) return [];
    const decoded = envelopes.map((envelope) => {
        const encryptedDataKey = decodeEnvelopeBytes(envelope.encryptedDataKey);
        return encryptedDataKey
            ? {
                recipientAccountId: envelope.recipientAccountId,
                encryptedDataKey,
                recipientContentPublicKeyFingerprint: envelope.recipientContentPublicKeyFingerprint,
            }
            : null;
    });
    return decoded.every((envelope): envelope is NonNullable<typeof envelope> => envelope !== null)
        ? decoded
        : null;
}

export function registerSavedSecretResourceRoutes(app: Fastify): void {
    // Shared Saved Secrets consume the existing `teams` decision, not either
    // credential-resource bit, and remain unadvertised until their own atomic
    // storage/catalog journey exists. A disabled `teams` gate must still answer
    // in the strict SavedSecret vocabulary so a client decoding the refusal
    // meets a body its schema accepts; the generic `{ error: "not_found" }`
    // default is not a SavedSecretResourceActionErrorV1 member.
    const routes = createTeamRouteApp(app, {
        unavailableBody: { error: "forbidden" },
        unavailableStatus: 403,
    });
    routes.get(homeDomainActionPathForMethod("secrets.shared.list", "GET"), {
        preHandler: app.authenticate,
        // Catalog reads intentionally return metadata only. Raw plaintext or
        // recipient DEKs are never exposed through a generic HTTP reveal API;
        // materialization remains owned by the admitted daemon/client path.
        schema: { response: { 200: SharedSavedSecretListOutputV1Schema, 403: SavedSecretResourceActionErrorV1Schema, 500: SavedSecretResourceActionErrorV1Schema } },
    }, async (request, reply) => {
        try {
            const authentication = readTeamOperationAuthenticationFromRequest(request);
            const resources = await inTx((tx) => listSavedSecretResourcesForAccountInTx(
                tx,
                request.userId,
                authentication,
            ));
            return reply.send({ resources: [...resources] });
        } catch {
            return reply.code(500).send({ error: "internal" });
        }
    });

    routes.get("/v1/account/saved-secrets/resources/materials", {
        preHandler: app.authenticate,
        schema: { response: { 200: SavedSecretResourceMaterialsResponseV1Schema, 403: SavedSecretResourceActionErrorV1Schema, 500: SavedSecretResourceActionErrorV1Schema } },
    }, async (request, reply) => {
        try {
            const authentication = readTeamOperationAuthenticationFromRequest(request);
            const rows = await inTx((tx) => listSavedSecretResourceMaterialsForAccountInTx(
                tx,
                request.userId,
                authentication,
            ));
            return reply.send({
                resources: rows.map((row) => {
                    if (!("resourceId" in row)) return { entry: row.entry };
                    return {
                        resourceId: row.resourceId,
                        encryptionMode: row.encryptionMode,
                        entry: row.entry,
                        storedContent: row.storedContent,
                        recipientEnvelope: row.encryptedDataKey && row.recipientContentPublicKeyFingerprint
                        ? {
                            encryptedDataKey: encodeBase64(copyBytes(row.encryptedDataKey), "base64"),
                            recipientContentPublicKeyFingerprint: row.recipientContentPublicKeyFingerprint,
                        }
                        : null,
                    };
                }),
            });
        } catch {
            return reply.code(500).send({ error: "internal" });
        }
    });

    routes.get("/v1/account/saved-secrets/resources/envelope-census", {
        preHandler: app.authenticate,
        schema: {
            querystring: SavedSecretResourceEnvelopeCensusRequestV1Schema,
            response: {
                200: SavedSecretResourceEnvelopeCensusResponseV1Schema,
                400: SavedSecretResourceActionErrorV1Schema,
                403: SavedSecretResourceActionErrorV1Schema,
                404: SavedSecretResourceActionErrorV1Schema,
            },
        },
    }, async (request, reply) => {
        const parsed = SavedSecretResourceEnvelopeCensusRequestV1Schema.safeParse(request.query);
        if (!parsed.success) return reply.code(400).send({ error: "invalid_cursor" });
        const result = await inTx((tx) => listSavedSecretResourceEnvelopeCensusInTx(tx, {
            accountId: request.userId,
            resourceId: parsed.data.resourceId,
            cursor: parsed.data.cursor,
            limit: parsed.data.limit,
        }));
        if (!result.ok) {
            if (result.error === "forbidden") {
                return reply.code(403).send({ error: result.error });
            }
            if (result.error === "resource_not_found") {
                return reply.code(404).send({ error: result.error });
            }
            return reply.code(400).send({ error: result.error });
        }
        return reply.code(200).send({
            ...result.value,
            recipients: [...result.value.recipients],
        });
    });

    routes.post("/v1/account/saved-secrets/resources/envelopes/repair", {
        preHandler: [app.authenticate, requirePresentUser],
        schema: {
            body: SavedSecretResourceEnvelopeRepairInputV1Schema,
            response: {
                200: SavedSecretResourceEnvelopeRepairOutputV1Schema,
                400: SavedSecretResourceActionErrorV1Schema,
                403: z.union([PresentUserRequiredResponseSchema, SavedSecretResourceActionErrorV1Schema]),
                404: SavedSecretResourceActionErrorV1Schema,
                409: SavedSecretResourceActionErrorV1Schema,
            },
        },
    }, async (request, reply) => {
        const parsed = SavedSecretResourceEnvelopeRepairInputV1Schema.safeParse(request.body);
        if (!parsed.success) return reply.code(400).send({ error: "invalid_resource" });
        const keyEnvelopes = decodeEnvelopes(parsed.data.keyEnvelopes);
        if (!keyEnvelopes) return reply.code(400).send({ error: "invalid_resource" });
        const result = await inTx((tx) => repairSavedSecretResourceKeyEnvelopesInTx(tx, {
            accountId: request.userId,
            resourceId: parsed.data.resourceId,
            expectedRevision: parsed.data.expectedRevision,
            keyEnvelopes,
        }));
        if (!result.ok) {
            const status = result.error === "forbidden" ? 403
                : result.error === "resource_not_found" ? 404
                    : result.error === "resource_changed" || result.error === "recipient_changed" ? 409 : 400;
            return reply.code(status).send({ error: result.error });
        }
        return reply.send(result.value);
    });

    routes.post(homeDomainActionPathForMethod("secrets.shared.create", "POST"), {
        preHandler: [app.authenticate, requirePresentUser],
        schema: {
            body: SharedSavedSecretCreateInputV1Schema,
            response: {
                200: SharedSavedSecretMutationOutputV1Schema,
                400: SavedSecretResourceActionErrorV1Schema,
                403: z.union([PresentUserRequiredResponseSchema, SavedSecretResourceActionErrorV1Schema]),
                409: SavedSecretResourceActionErrorV1Schema,
            },
        },
    }, async (request, reply) => {
        const parsed = SharedSavedSecretCreateInputV1Schema.safeParse(request.body);
        if (!parsed.success) return reply.code(400).send({ error: "invalid_resource" });
        const body = parsed.data;
        const keyEnvelopes = decodeEnvelopes(body.keyEnvelopes);
        if (!keyEnvelopes) return reply.code(400).send({ error: "invalid_resource" });
        const authentication = readTeamOperationAuthenticationFromRequest(request);
        const result = await inTx((tx) => createSavedSecretResourceInTx(tx, {
            accountId: request.userId,
            authentication,
            resourceId: body.resourceId,
            displayName: body.displayName,
            kind: body.kind,
            encryptionMode: body.encryptionMode,
            storedContent: body.storedContent,
            accountGrants: body.accountGrants,
            teamGrants: body.teamGrants,
            groupGrants: body.groupGrants,
            keyEnvelopes,
        }));
        if (!result.ok) {
            const status = result.error === "forbidden" || result.error === "recipient_mode_unsupported" ? 403
                : result.error === "resource_changed" || result.error === "settings_conflict" ? 409 : 400;
            return reply.code(status).send({ error: result.error });
        }
        return reply.send(result.value);
    });

    routes.post(homeDomainActionPathForMethod("secrets.shared.promote", "POST"), {
        preHandler: [app.authenticate, requirePresentUser],
        schema: {
            body: SharedSavedSecretPromoteInputV1Schema,
            response: {
                200: SharedSavedSecretPromoteOutputV1Schema,
                400: SavedSecretResourceActionErrorV1Schema,
                403: z.union([PresentUserRequiredResponseSchema, SavedSecretResourceActionErrorV1Schema]),
                409: SavedSecretResourceActionErrorV1Schema,
            },
        },
    }, async (request, reply) => {
        const parsed = SharedSavedSecretPromoteInputV1Schema.safeParse(request.body);
        if (!parsed.success) return reply.code(400).send({ error: "invalid_resource" });
        const body = parsed.data;
        const keyEnvelopes = decodeEnvelopes(body.keyEnvelopes);
        if (!keyEnvelopes) return reply.code(400).send({ error: "invalid_resource" });
        let result;
        try {
            result = await inTx((tx) => promoteSavedSecretResourceInTx(tx, {
                accountId: request.userId,
                authentication: readTeamOperationAuthenticationFromRequest(request),
                resourceId: body.resourceId,
                displayName: body.displayName,
                kind: body.kind,
                encryptionMode: body.encryptionMode,
                storedContent: body.storedContent,
                accountGrants: body.accountGrants,
                teamGrants: body.teamGrants,
                groupGrants: body.groupGrants,
                keyEnvelopes,
                expectedSettingsVersion: body.expectedSettingsVersion,
                nextSettings: body.nextSettings,
                referenceCensus: body.referenceCensus,
                profileMutations: body.profileMutations,
            }));
        } catch (error) {
            if (error instanceof SavedSecretResourceTransactionAbort) {
                const status = error.error === "settings_conflict" || error.error === 'references_conflict' || error.error === 'resource_changed' ? 409 : 400;
                return reply.code(status).send({ error: error.error });
            }
            throw error;
        }
        if (!result.ok) {
            const status = result.error === "forbidden" || result.error === "recipient_mode_unsupported" ? 403
                : result.error === "resource_changed" || result.error === "settings_conflict" || result.error === 'references_conflict' ? 409 : 400;
            return reply.code(status).send({ error: result.error });
        }
        return reply.send(result.value);
    });

    routes.post(homeDomainActionPathForMethod("secrets.shared.update", "POST"), {
        preHandler: [app.authenticate, requirePresentUser],
        schema: {
            body: SharedSavedSecretUpdateInputV1Schema,
            response: {
                200: SharedSavedSecretMutationOutputV1Schema,
                400: SavedSecretResourceActionErrorV1Schema,
                403: z.union([PresentUserRequiredResponseSchema, SavedSecretResourceActionErrorV1Schema]),
                404: SavedSecretResourceActionErrorV1Schema,
                409: SavedSecretResourceActionErrorV1Schema,
            },
        },
    }, async (request, reply) => {
        const parsed = SharedSavedSecretUpdateInputV1Schema.safeParse(request.body);
        if (!parsed.success) return reply.code(400).send({ error: "invalid_resource" });
        const body = parsed.data;
        const keyEnvelopes = decodeEnvelopes(body.keyEnvelopes);
        if (!keyEnvelopes) return reply.code(400).send({ error: "invalid_resource" });
        const result = await inTx((tx) => updateSavedSecretResourceInTx(tx, {
            accountId: request.userId,
            resourceId: body.resourceId,
            expectedRevision: body.expectedRevision,
            displayName: body.displayName,
            kind: body.kind,
            storedContent: body.storedContent,
            ...(body.toMode ? { toMode: body.toMode } : {}),
            keyEnvelopes,
        }));
        if (!result.ok) {
            const status = result.error === "forbidden" || result.error === "recipient_mode_unsupported" ? 403
                : result.error === "resource_not_found" ? 404
                    : result.error === "resource_changed" ? 409 : 400;
            return reply.code(status).send({ error: result.error });
        }
        return reply.send(result.value);
    });

    routes.post(homeDomainActionPathForMethod("secrets.shared.grants.set", "POST"), {
        preHandler: [app.authenticate, requirePresentUser],
        schema: {
            body: SharedSavedSecretGrantsSetInputV1Schema,
            response: {
                200: SharedSavedSecretMutationOutputV1Schema,
                400: SavedSecretResourceActionErrorV1Schema,
                403: z.union([PresentUserRequiredResponseSchema, SavedSecretResourceActionErrorV1Schema]),
                409: SavedSecretResourceActionErrorV1Schema,
            },
        },
    }, async (request, reply) => {
        const parsed = SharedSavedSecretGrantsSetInputV1Schema.safeParse(request.body);
        if (!parsed.success) return reply.code(400).send({ error: "invalid_resource" });
        const keyEnvelopes = decodeEnvelopes(parsed.data.keyEnvelopes);
        if (!keyEnvelopes) return reply.code(400).send({ error: "invalid_resource" });
        const { keyEnvelopes: _encodedEnvelopes, ...body } = parsed.data;
        const authentication = readTeamOperationAuthenticationFromRequest(request);
        const result = await inTx((tx) => setSavedSecretResourceGrantsInTx(tx, {
            accountId: request.userId,
            authentication,
            ...body,
            keyEnvelopes,
        }));
        if (!result.ok) {
            const status = result.error === "forbidden" ? 403
                : result.error === "resource_changed" ? 409 : 400;
            return reply.code(status).send({ error: result.error });
        }
        return reply.send(result.value);
    });

    routes.post(homeDomainActionPathForMethod("secrets.shared.delete", "POST"), {
        preHandler: [app.authenticate, requirePresentUser],
        schema: {
            body: SharedSavedSecretDeleteInputV1Schema,
            response: {
                200: SharedSavedSecretDeleteOutputV1Schema,
                400: SavedSecretResourceActionErrorV1Schema,
                403: z.union([PresentUserRequiredResponseSchema, SavedSecretResourceActionErrorV1Schema]),
                404: SavedSecretResourceActionErrorV1Schema,
                409: SavedSecretResourceActionErrorV1Schema,
            },
        },
    }, async (request, reply) => {
        const parsed = SharedSavedSecretDeleteInputV1Schema.safeParse(request.body);
        if (!parsed.success) return reply.code(400).send({ error: "invalid_resource" });
        const body = parsed.data;
        let result;
        try {
            result = await inTx((tx) => deleteSavedSecretResourceInTx(tx, {
                accountId: request.userId,
                resourceId: body.resourceId,
                expectedRevision: body.expectedRevision,
                expectedSettingsVersion: body.expectedSettingsVersion,
                referenceCensus: body.referenceCensus,
                managedResourceDispositions: body.managedResourceDispositions,
            }));
        } catch (error) {
            if (error instanceof SavedSecretResourceTransactionAbort) {
                const status = error.error === 'resource_changed' || error.error === 'references_conflict' || error.error === 'settings_conflict' ? 409 : 400;
                return reply.code(status).send({ error: error.error });
            }
            throw error;
        }
        if (!result.ok) {
            if (result.error === "managed_resources_review_required") return reply.code(409).send({ error: result.error, resources: [...result.resources] });
            const status = result.error === "resource_not_found" ? 404
                : result.error === "resource_changed" || result.error === 'settings_conflict' || result.error === 'references_conflict' ? 409
                    : result.error === "forbidden" ? 403 : 400;
            return reply.code(status).send({ error: result.error });
        }
        return reply.send(result.value);
    });
}
