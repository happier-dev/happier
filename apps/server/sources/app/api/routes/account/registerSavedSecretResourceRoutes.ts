import { decodeBase64, encodeBase64 } from "privacy-kit";
import { z } from "zod/mini";

import { SavedSecretResourceActionErrorV1Schema, SavedSecretResourceEnvelopeRepairInputV1Schema, SavedSecretResourceEnvelopeRepairOutputV1Schema, SavedSecretResourceRecipientEnvelopeInputV1Schema, SharedSavedSecretCreateInputV1Schema, SharedSavedSecretDeleteInputV1Schema, SharedSavedSecretDeleteOutputV1Schema, SharedSavedSecretGrantsSetInputV1Schema, SharedSavedSecretListOutputV1Schema, SharedSavedSecretMutationOutputV1Schema, SharedSavedSecretPromoteInputV1Schema, SharedSavedSecretPromoteOutputV1Schema, SharedSavedSecretUpdateInputV1Schema } from '@happier-dev/protocol/account/settings/savedSecretResourceActionsV1';
import { SavedSecretResourceMaterialsResponseV1Schema, SavedSecretResourceEnvelopeCensusRequestV1Schema, SavedSecretResourceEnvelopeCensusResponseV1Schema } from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';
import { inReadSnapshot, inTx } from "@/storage/inTx";
import { AccountSettingsPublicationConflict } from '@/app/accountSettings/writeAccountSettingsInTx';
import { readUserKvMutationConflict } from '@/app/kv/kvMutate';
import { type Fastify } from "../../types";
import { requirePresentUser, PresentUserRequiredResponseSchema } from "@/app/api/utils/requirePresentUser";
import {
    createSavedSecretResourceInTx,
    admitSavedSecretResourceManagementInTx,
    deleteSavedSecretResourceInTx,
    listSavedSecretResourceMaterialsForAccountInTx,
    listSavedSecretResourceEnvelopeCensusInTx,
    listSavedSecretResourcesForAccountInTx,
    promoteSavedSecretResourceInTx,
    repairSavedSecretResourceKeyEnvelopesInTx,
    SavedSecretResourceTransactionAbort,
    setSavedSecretResourceGrantsInTx,
    updateSavedSecretResourceInTx,
    type SavedSecretResourceServiceError,
} from "@/app/account/savedSecrets/savedSecretResourceService";
import { homeDomainActionPathForMethod } from "@/app/api/routes/actions/homeDomainActionRoute";
import { readTeamOperationAuthenticationFromRequest } from "@/app/teams/actorContext";
import { SavedSecretResourceMaterialSelectionV1Schema } from '@happier-dev/protocol/account/settings/savedSecretResourceActionsV1';

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

// Entity catalog routes consume the same wire-to-native envelope boundary.
export { decodeEnvelopes as decodeSavedSecretResourceEnvelopes };

// Composite mutations can return a rejection or throw it to roll back earlier
// writes. Its public classification must be independent of that transaction path.
function savedSecretResourceErrorHttpStatus<MissingResourceStatus extends 400 | 404>(
    error: "resource_not_found" | "forbidden" | "invalid_resource",
    missingResourceStatus: MissingResourceStatus,
): 400 | 403 | MissingResourceStatus;
function savedSecretResourceErrorHttpStatus<MissingResourceStatus extends 400 | 404>(
    error: SavedSecretResourceServiceError,
    missingResourceStatus: MissingResourceStatus,
): 400 | 403 | 409 | MissingResourceStatus;
function savedSecretResourceErrorHttpStatus(
    error: SavedSecretResourceServiceError,
    missingResourceStatus: 400 | 404,
): 400 | 403 | 404 | 409 {
    if (error === "forbidden" || error === "recipient_mode_unsupported") return 403;
    if (error === "resource_not_found") return missingResourceStatus;
    if (error === "resource_changed" || error === "recipient_changed"
        || error === "settings_conflict" || error === "references_conflict") return 409;
    return 400;
}

export function registerSavedSecretResourceRoutes(app: Fastify): void {
    // Personal resource management does not require Teams. The resource owner
    // still gates every Team-derived audience/access arm before admitting it.
    const routes = app;
    routes.get(homeDomainActionPathForMethod("secrets.shared.list", "GET"), {
        preHandler: app.authenticate,
        // Catalog reads intentionally return metadata only. Raw plaintext or
        // recipient DEKs are never exposed through a generic HTTP reveal API;
        // materialization remains owned by the admitted daemon/client path.
        schema: { response: { 200: SharedSavedSecretListOutputV1Schema, 403: SavedSecretResourceActionErrorV1Schema, 500: SavedSecretResourceActionErrorV1Schema } },
    }, async (request, reply) => {
        try {
            const authentication = readTeamOperationAuthenticationFromRequest(request);
            const resources = await inReadSnapshot((tx) => listSavedSecretResourcesForAccountInTx(
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
        schema: { querystring: SavedSecretResourceMaterialSelectionV1Schema, response: { 200: SavedSecretResourceMaterialsResponseV1Schema, 400: SavedSecretResourceActionErrorV1Schema, 403: SavedSecretResourceActionErrorV1Schema, 404: SavedSecretResourceActionErrorV1Schema, 409: SavedSecretResourceActionErrorV1Schema, 500: SavedSecretResourceActionErrorV1Schema } },
    }, async (request, reply) => {
        try {
            const authentication = readTeamOperationAuthenticationFromRequest(request);
            const selection = request.query;
            if (selection.requireManage && (request.authTokenKind !== 'account' || request.authAuthority !== 'present_user')) {
                return reply.code(403).send({ error: 'forbidden' });
            }
            const result = await inReadSnapshot(async tx => {
                // Check management and exact currentness without reading the body.
                if (selection.resourceId && selection.requireManage) {
                    const current = await admitSavedSecretResourceManagementInTx(tx, { accountId: request.userId,
                        resourceId: selection.resourceId, expectedRevision: selection.expectedRevision, authentication });
                    if (!current.ok) return current;
                }
                const rows = await listSavedSecretResourceMaterialsForAccountInTx(tx, request.userId, authentication,
                    selection.resourceId ? [selection.resourceId] : undefined, selection.includeReferenceCensus === true);
                if (selection.resourceId && !selection.requireManage && selection.expectedRevision !== undefined) {
                    // The qualified loader decides access first; an unauthorized resource answers like a missing one.
                    if (rows.length === 0) return { ok: false as const, error: 'resource_not_found' as const };
                    const current = await tx.savedSecretResource.findUnique({ where: { id: selection.resourceId }, select: { revision: true } });
                    if (current?.revision !== selection.expectedRevision) return { ok: false as const, error: 'resource_changed' as const };
                }
                return { ok: true as const, rows };
            });
            if (!result.ok) return reply.code(savedSecretResourceErrorHttpStatus(result.error, 404)).send({ error: result.error });
            const rows = result.rows;
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
        const result = await inReadSnapshot((tx) => listSavedSecretResourceEnvelopeCensusInTx(tx, {
            accountId: request.userId,
            resourceId: parsed.data.resourceId,
            cursor: parsed.data.cursor,
            limit: parsed.data.limit,
            authentication: readTeamOperationAuthenticationFromRequest(request),
        }));
        if (!result.ok) {
            return reply.code(savedSecretResourceErrorHttpStatus(result.error, 404)).send({ error: result.error });
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
        }), { /* Secret recipient keys, effective grants and cross-owner reference censuses must stay coherent. */ isolationLevel: "Serializable" });
        if (!result.ok) {
            return reply.code(savedSecretResourceErrorHttpStatus(result.error, 404)).send({ error: result.error });
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
        }), { /* Secret recipient keys, effective grants and cross-owner reference censuses must stay coherent. */ isolationLevel: "Serializable" });
        if (!result.ok) {
            return reply.code(savedSecretResourceErrorHttpStatus(result.error, 400)).send({ error: result.error });
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
        const additionalResources = (body.additionalSavedSecretResources ?? []).map(resource => {
            const decoded = decodeEnvelopes(resource.keyEnvelopes);
            return decoded ? { ...resource, keyEnvelopes: decoded } : null;
        });
        if (additionalResources.some(resource => resource === null)) return reply.code(400).send({ error: "invalid_resource" });
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
                catalogMutations: body.catalogMutations,
                remoteHostMutation: body.remoteHostMutation,
                notificationChannelMutation: body.notificationChannelMutation,
                ...(body.connectedAccountCredentialMutation ? { connectedAccountCredentialMutation: body.connectedAccountCredentialMutation } : {}),
                additionalSavedSecretResources: additionalResources.filter((resource): resource is NonNullable<typeof resource> => resource !== null),
                personalSecretPromotions: body.personalSecretPromotions,
            }), { /* Secret recipient keys, effective grants and cross-owner reference censuses must stay coherent. */ isolationLevel: "Serializable" });
        } catch (error) {
            if (await readUserKvMutationConflict(error)) {
                return reply.code(savedSecretResourceErrorHttpStatus('references_conflict', 400)).send({ error: 'references_conflict' });
            }
            if (error instanceof AccountSettingsPublicationConflict) {
                const failure = error.result.status === 'version_mismatch' ? 'settings_conflict'
                    : error.result.status === 'profile_transfer_mismatch' ? 'references_conflict' : 'settings_invalid';
                return reply.code(savedSecretResourceErrorHttpStatus(failure, 400)).send({ error: failure });
            }
            if (error instanceof SavedSecretResourceTransactionAbort) {
                return reply.code(savedSecretResourceErrorHttpStatus(error.error, 400)).send({ error: error.error });
            }
            throw error;
        }
        if (!result.ok) {
            return reply.code(savedSecretResourceErrorHttpStatus(result.error, 400)).send({ error: result.error });
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
        }), { /* Secret recipient keys, effective grants and cross-owner reference censuses must stay coherent. */ isolationLevel: "Serializable" });
        if (!result.ok) {
            return reply.code(savedSecretResourceErrorHttpStatus(result.error, 404)).send({ error: result.error });
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
        }), { /* Secret recipient keys, effective grants and cross-owner reference censuses must stay coherent. */ isolationLevel: "Serializable" });
        if (!result.ok) {
            return reply.code(savedSecretResourceErrorHttpStatus(result.error, 400)).send({ error: result.error });
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
            }), { /* Secret recipient keys, effective grants and cross-owner reference censuses must stay coherent. */ isolationLevel: "Serializable" });
        } catch (error) {
            if (await readUserKvMutationConflict(error)) {
                return reply.code(savedSecretResourceErrorHttpStatus('references_conflict', 404)).send({ error: 'references_conflict' });
            }
            if (error instanceof SavedSecretResourceTransactionAbort) {
                return reply.code(savedSecretResourceErrorHttpStatus(error.error, 404)).send({ error: error.error });
            }
            throw error;
        }
        if (!result.ok) {
            if (result.error === "managed_resources_review_required") return reply.code(409).send({ error: result.error, resources: [...result.resources] });
            return reply.code(savedSecretResourceErrorHttpStatus(result.error, 404)).send({ error: result.error });
        }
        return reply.send(result.value);
    });
}
