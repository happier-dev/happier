import { createArtifactHttpMutation, updateArtifactHttpMutation } from '@/app/artifacts/artifactMutationHttpResponse';
import { registerArtifactUploadRoutes } from './registerArtifactUploadRoutes';
import { readArtifactAccountEncryptionMigrationInventoryInTx } from '@/app/artifacts/artifactAccountEncryptionMigrationInventory';
import { eventRouter, buildNewArtifactUpdate, buildUpdateArtifactUpdate, buildDeleteArtifactUpdate } from "@/app/events/eventRouter";
import { inTx } from "@/storage/inTx";
import {
    commitArtifactRecipientKeyEnvelopesInTx,
    listArtifactAccessGrantsInTx,
    listArtifactHeadersForCallerInTx,
    readArtifactForCallerInTx,
    readArtifactRecipientCensusInTx,
    removeArtifactAccessGrantInTx,
    setArtifactAccessGrantInTx,
} from "@/app/artifacts/artifactAccessService";
import { Fastify } from "../../types";
import { z } from "zod";
import { randomKeyNaked } from "@/utils/keys/randomKeyNaked";
import { log } from "@/utils/logging/log";
import * as privacyKit from "privacy-kit";
import { createArtifact, deleteArtifact, updateArtifact } from "@/app/artifacts/artifactWriteService";
import { listArtifactBodyRevisionsInTx, restoreArtifactBodyRevision } from "@/app/artifacts/artifactRevisionService";
import { ArtifactStorageSizeUnavailableError, readArtifactStorageUsageInTx } from "@/app/artifacts/artifactStorageService";
import { readArtifactBlob } from '@/app/artifacts/artifactBlobService';
import { resolveStoredContentPublicShareOrigin } from '@/app/share/storedContentPublicShareOrigin';
import { registerArtifactHtmlViewerRoutes } from '../share/registerPublicShareViewerRoutes';
import { resolveApiHotEndpointRateLimit } from "@/app/api/utils/apiRateLimitCatalog";
import {
    ArtifactCallerAccessV1Schema,
    ArtifactAccessGrantSetStorageInputV1Schema,
    ArtifactAccessGrantRemoveInputV1Schema,
    ArtifactAccessGrantsListResponseV1Schema,
    ArtifactAccessGrantMutationResponseV1Schema,
    ArtifactAccessRecipientCensusResponseV1Schema,
    ArtifactRecipientKeyEnvelopeCommitInputV1Schema,
    ArtifactRecipientKeyEnvelopeCommitResponseV1Schema,
    ArtifactAccessErrorCodeV1Schema,
    ArtifactRevisionListResponseV1Schema,
    ArtifactStorageUsageV1Schema,
    ArtifactQuotaExceededV1Schema,
    ArtifactBlobWriteV1Schema, ArtifactBlobReadResponseV1Schema,
    ArtifactHtmlPreviewResponseV1Schema,
    ArtifactAccountEncryptionMigrationInventoryV1Schema,
} from "@happier-dev/protocol";

const DEFAULT_ARTIFACT_LIST_LIMIT = 500;

function parseArtifactListCursor(value: string | undefined): { updatedAt: Date; id: string } | null {
    if (!value) return null;
    try {
        const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
        if (!decoded || typeof decoded !== "object") return null;
        const record = decoded as Record<string, unknown>;
        const updatedAt = new Date(Number(record.updatedAt));
        return typeof record.id === "string" && Number.isFinite(updatedAt.getTime())
            ? { updatedAt, id: record.id }
            : null;
    } catch {
        return null;
    }
}

export function artifactsRoutes(app: Fastify) {
    registerArtifactUploadRoutes(app);
    registerArtifactHtmlViewerRoutes(app);
    app.get('/v1/account/encryption/artifacts', {
        preHandler: app.authenticate,
        config: { rateLimit: resolveApiHotEndpointRateLimit(process.env, 'artifacts') },
        schema: { querystring: z.object({ afterId: z.string().min(1).optional(),
            limit: z.coerce.number().int().min(1).max(DEFAULT_ARTIFACT_LIST_LIMIT).optional() }).strict(),
            response: { 200: ArtifactAccountEncryptionMigrationInventoryV1Schema,
                503: z.object({ error: z.literal('artifact_content_unavailable') }).strict() } },
    }, async (request, reply) => {
        const inventory = await inTx(tx => readArtifactAccountEncryptionMigrationInventoryInTx({ tx, accountId: request.userId,
            afterId: request.query.afterId, limit: request.query.limit ?? DEFAULT_ARTIFACT_LIST_LIMIT }));
        return inventory ? reply.send(inventory) : reply.code(503).send({ error: 'artifact_content_unavailable' });
    });
    app.get('/v1/artifacts/:id/html-preview', {
        preHandler: app.authenticate,
        config: { rateLimit: resolveApiHotEndpointRateLimit(process.env, 'artifacts') },
        schema: { params: z.object({ id: z.string().min(1) }).strict(), response: {
            200: ArtifactHtmlPreviewResponseV1Schema,
            404: z.object({ error: z.literal('Artifact not found') }),
            503: z.object({ error: z.enum(['artifact_content_unavailable', 'artifact_html_isolation_unavailable']) }),
        } },
    }, async (request, reply) => {
        const read = await inTx(tx => readArtifactForCallerInTx(tx, { actorAccountId: request.userId, artifactId: request.params.id }));
        if (!read.ok) return read.error === 'artifact_not_found'
            ? reply.code(404).send({ error: 'Artifact not found' }) : reply.code(503).send({ error: 'artifact_content_unavailable' });
        const origin = resolveStoredContentPublicShareOrigin(request.params.id);
        if (!origin) return reply.code(503).send({ error: 'artifact_html_isolation_unavailable' });
        return reply.send({ url: `${origin}/a/${encodeURIComponent(request.params.id)}` });
    });
    app.get('/v1/artifacts/:id/blobs/:blobId', {
        preHandler: app.authenticate,
        config: { rateLimit: resolveApiHotEndpointRateLimit(process.env, 'artifacts') },
        schema: { params: z.object({ id: z.string(), blobId: z.string().uuid() }), response: {
            200: ArtifactBlobReadResponseV1Schema,
            404: z.object({ error: z.literal('Artifact not found') }),
            503: z.object({ error: z.literal('artifact_content_unavailable') }),
        } },
    }, async (request, reply) => {
        try {
            const result = await readArtifactBlob({ actorAccountId: request.userId, artifactId: request.params.id, blobId: request.params.blobId });
            if (!result.ok) return result.error === 'artifact_not_found'
                ? reply.code(404).send({ error: 'Artifact not found' }) : reply.code(503).send({ error: 'artifact_content_unavailable' });
            return reply.send(result.value);
        } catch { return reply.code(503).send({ error: 'artifact_content_unavailable' }); }
    });
    app.get('/v1/artifacts/storage/usage', {
        preHandler: app.authenticate,
        config: { rateLimit: resolveApiHotEndpointRateLimit(process.env, "artifacts") },
        schema: { response: { 200: ArtifactStorageUsageV1Schema,
            503: z.object({ error: z.literal('storage_size_out_of_range') }) } },
    }, async (request, reply) => {
        try { return reply.send(await inTx(tx => readArtifactStorageUsageInTx(tx, request.userId))); }
        catch (error) {
            if (error instanceof ArtifactStorageSizeUnavailableError) return reply.code(503).send({ error: error.code });
            throw error;
        }
    });

    app.get('/v1/artifacts/:id/revisions', {
        preHandler: app.authenticate,
        config: { rateLimit: resolveApiHotEndpointRateLimit(process.env, "artifacts") },
        schema: { params: z.object({ id: z.string() }), response: {
            200: ArtifactRevisionListResponseV1Schema,
            404: z.object({ error: z.literal('Artifact not found') }),
            503: z.object({ error: z.literal('artifact_content_unavailable') }),
        } },
    }, async (request, reply) => {
        const result = await inTx(tx => listArtifactBodyRevisionsInTx(tx, { actorAccountId: request.userId, artifactId: request.params.id }));
        if (!result.ok) return result.error === 'artifact_not_found'
            ? reply.code(404).send({ error: 'Artifact not found' })
            : reply.code(503).send({ error: 'artifact_content_unavailable' });
        return reply.send({ retentionCount: result.retentionCount, revisions: result.revisions.map(revision => ({
            ...revision, body: privacyKit.encodeBase64(revision.body), createdAt: revision.createdAt.getTime(),
        })) });
    });

    app.post('/v1/artifacts/:id/revisions/:bodyVersion/restore', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ id: z.string(), bodyVersion: z.coerce.number().int().min(1) }),
            body: z.object({ header: z.string(), body: z.string().optional(),
                expectedHeaderVersion: z.number().int().min(1), expectedBodyVersion: z.number().int().min(1) }).strict(),
            response: {
                200: z.union([
                    z.object({ success: z.literal(true), headerVersion: z.number(), bodyVersion: z.number() }),
                    z.object({ success: z.literal(false), error: z.literal('version-mismatch'), currentHeaderVersion: z.number(),
                        currentBodyVersion: z.number(), currentHeader: z.string(), currentBody: z.string() }),
                ]),
                400: z.object({ error: z.string() }),
                404: z.object({ error: z.literal('Artifact not found') }),
                413: ArtifactQuotaExceededV1Schema,
                500: z.object({ error: z.literal('Failed to restore artifact') }),
            },
        },
    }, async (request, reply) => {
        const result = await restoreArtifactBodyRevision({ actorUserId: request.userId, artifactId: request.params.id,
            bodyVersion: request.params.bodyVersion, header: privacyKit.decodeBase64(request.body.header),
            ...(request.body.body !== undefined ? { body: privacyKit.decodeBase64(request.body.body) } : {}),
            expectedRevision: { headerVersion: request.body.expectedHeaderVersion,
                bodyVersion: request.body.expectedBodyVersion } });
        if (!result.ok) {
            if (result.error === 'quota_exceeded') return reply.code(413).send({ error: result.error, budget: result.budget, limitBytes: result.limitBytes, usedBytes: result.usedBytes });
            if (result.error === 'not-found') return reply.code(404).send({ error: 'Artifact not found' });
            if (result.error === 'invalid-params') return reply.code(400).send({ error: 'Invalid parameters' });
            if (result.error === 'version-mismatch' && result.current) return reply.send({ success: false as const,
                error: 'version-mismatch' as const, currentHeaderVersion: result.current.headerVersion, currentBodyVersion: result.current.bodyVersion,
                currentHeader: privacyKit.encodeBase64(new Uint8Array(result.current.header)), currentBody: privacyKit.encodeBase64(new Uint8Array(result.current.body)) });
            return reply.code(500).send({ error: 'Failed to restore artifact' });
        }
        if (!result.header || !result.body) return reply.code(500).send({ error: 'Failed to restore artifact' });
        const recipient = result.ownerUpdate ?? { accountId: request.userId, cursor: result.cursor };
        eventRouter.emitUpdate({ userId: recipient.accountId,
            payload: buildUpdateArtifactUpdate(request.params.id, recipient.cursor, randomKeyNaked(12),
                { value: privacyKit.encodeBase64(new Uint8Array(result.header.bytes)), version: result.header.version },
                { value: privacyKit.encodeBase64(new Uint8Array(result.body.bytes)), version: result.body.version }),
            recipientFilter: { type: 'user-scoped-only' } });
        return reply.send({ success: true as const, headerVersion: result.header.version, bodyVersion: result.body.version });
    });

    // GET /v1/artifacts - List all artifacts for the account
    app.get('/v1/artifacts', {
        preHandler: app.authenticate,
        config: {
            rateLimit: resolveApiHotEndpointRateLimit(process.env, "artifacts"),
        },
        schema: {
            querystring: z.object({
                limit: z.coerce.number().int().min(1).max(500).optional(),
                cursor: z.string().min(1).optional(),
                includeBody: z.literal('true').optional(),
            }),
            response: {
                200: z.array(z.object({
                    id: z.string(),
                    header: z.string(),
                    headerVersion: z.number(),
                    body: z.string().optional(),
                    bodyVersion: z.number().optional(),
                    dataEncryptionKey: z.string(),
                    seq: z.number(),
                    createdAt: z.number(),
                    updatedAt: z.number(),
                    ownerAccountId: z.string(),
                    access: ArtifactCallerAccessV1Schema,
                    encryptionMode: ArtifactAccessRecipientCensusResponseV1Schema.shape.encryptionMode,
                })),
                400: z.object({ error: z.literal('Failed to get artifacts') }),
                500: z.object({
                    error: z.literal('Failed to get artifacts')
                })
            }
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const query = request.query as { limit?: number; cursor?: string; includeBody?: 'true' };
        const listLimit = typeof query.limit === "number" ? query.limit : DEFAULT_ARTIFACT_LIST_LIMIT;
        const cursor = parseArtifactListCursor(query.cursor);
        if (query.cursor && !cursor) return reply.code(400).send({ error: 'Failed to get artifacts' });

        try {
            const artifacts = await inTx(tx => listArtifactHeadersForCallerInTx(tx, { actorAccountId: userId, limit: listLimit, cursor,
                includeBody: query.includeBody === 'true' }));

            const projected = artifacts.map((artifact) => {
                return {
                    id: artifact.id,
                    ownerAccountId: artifact.ownerAccountId,
                    access: artifact.access,
                    encryptionMode: artifact.encryptionMode,
                    header: privacyKit.encodeBase64(artifact.header),
                    headerVersion: artifact.headerVersion,
                    ...(artifact.body === undefined ? {} : { body: privacyKit.encodeBase64(artifact.body), bodyVersion: artifact.bodyVersion }),
                    dataEncryptionKey: privacyKit.encodeBase64(artifact.dataEncryptionKey),
                    seq: artifact.seq,
                    createdAt: artifact.createdAt.getTime(),
                    updatedAt: artifact.updatedAt.getTime(),
                };
            });
            return reply.send(projected);
        } catch (error) {
            log({ module: 'api', level: 'error' }, `Failed to get artifacts: ${error}`);
            return reply.code(500).send({ error: 'Failed to get artifacts' });
        }
    });

    // GET /v1/artifacts/:id - Get single artifact with full body
    app.get('/v1/artifacts/:id', {
        preHandler: app.authenticate,
        config: {
            rateLimit: resolveApiHotEndpointRateLimit(process.env, "artifacts"),
        },
        schema: {
            params: z.object({
                id: z.string()
            }),
            response: {
                200: z.object({
                    id: z.string(),
                    header: z.string(),
                    headerVersion: z.number(),
                    body: z.string(),
                    bodyVersion: z.number(),
                    dataEncryptionKey: z.string(),
                    seq: z.number(),
                    createdAt: z.number(),
                    updatedAt: z.number(),
                    ownerAccountId: z.string(),
                    access: ArtifactCallerAccessV1Schema,
                    encryptionMode: ArtifactAccessRecipientCensusResponseV1Schema.shape.encryptionMode,
                }),
                404: z.object({
                    error: z.literal('Artifact not found')
                }),
                409: z.object({ error: z.literal("artifact_content_unavailable") }),
                500: z.object({
                    error: z.literal('Failed to get artifact')
                })
            }
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { id } = request.params;

        try {
            const read = await inTx(tx => readArtifactForCallerInTx(tx, { actorAccountId: userId, artifactId: id }));
            if (!read.ok) {
                return read.error === "artifact_not_found"
                    ? reply.code(404).send({ error: 'Artifact not found' })
                    : read.ownerAccountId === userId ? reply.code(500).send({ error: 'Failed to get artifact' })
                    : reply.code(409).send({ error: "artifact_content_unavailable" });
            }
            const artifact = read.artifact;

            return reply.send({
                id: artifact.id,
                ownerAccountId: artifact.ownerAccountId,
                access: artifact.access,
                encryptionMode: artifact.encryptionMode,
                header: privacyKit.encodeBase64(artifact.header),
                headerVersion: artifact.headerVersion,
                body: privacyKit.encodeBase64(artifact.body),
                bodyVersion: artifact.bodyVersion,
                dataEncryptionKey: privacyKit.encodeBase64(artifact.dataEncryptionKey),
                seq: artifact.seq,
                createdAt: artifact.createdAt.getTime(),
                updatedAt: artifact.updatedAt.getTime()
            });
        } catch (error) {
            log({ module: 'api', level: 'error' }, `Failed to get artifact: ${error}`);
            return reply.code(500).send({ error: 'Failed to get artifact' });
        }
    });

    const accessParams = z.object({ id: z.string().min(1) }).strict();
    const accessError = z.object({ error: ArtifactAccessErrorCodeV1Schema }).strict();
    const accessErrors = { 400: accessError, 403: accessError, 404: accessError, 409: accessError };
    const accessErrorStatus = (error: string) => error === "artifact_not_found" ? 404
        : error === "artifact_access_forbidden" ? 403
            : error === "artifact_content_unavailable" || error === "artifact_data_key_changed" ? 409 : 400;
    app.get('/v1/artifacts/:id/access/grants', {
        preHandler: app.authenticate,
        schema: { params: accessParams, response: { 200: ArtifactAccessGrantsListResponseV1Schema, ...accessErrors } },
    }, async (request, reply) => {
        const result = await inTx(tx => listArtifactAccessGrantsInTx(tx, { actorAccountId: request.userId, artifactId: request.params.id }));
        return result.ok ? reply.send(result.value) : reply.code(accessErrorStatus(result.error)).send({ error: result.error });
    });
    app.put('/v1/artifacts/:id/access/grants', {
        preHandler: app.authenticate,
        schema: { params: accessParams, body: ArtifactAccessGrantSetStorageInputV1Schema,
            response: { 200: ArtifactAccessGrantMutationResponseV1Schema, ...accessErrors } },
    }, async (request, reply) => {
        if (request.body.artifactId !== request.params.id) return reply.code(400).send({ error: "artifact_not_found" });
        const result = await inTx(tx => setArtifactAccessGrantInTx(tx, { ...request.body, actorAccountId: request.userId }));
        return result.ok ? reply.send(result.value) : reply.code(accessErrorStatus(result.error)).send({ error: result.error });
    });
    app.delete('/v1/artifacts/:id/access/grants', {
        preHandler: app.authenticate,
        schema: { params: accessParams, body: ArtifactAccessGrantRemoveInputV1Schema,
            response: { 200: ArtifactAccessGrantMutationResponseV1Schema, ...accessErrors } },
    }, async (request, reply) => {
        if (request.body.artifactId !== request.params.id) return reply.code(400).send({ error: "artifact_not_found" });
        const result = await inTx(tx => removeArtifactAccessGrantInTx(tx, { ...request.body, actorAccountId: request.userId }));
        return result.ok ? reply.send(result.value) : reply.code(accessErrorStatus(result.error)).send({ error: result.error });
    });
    app.get('/v1/artifacts/:id/access/recipients', {
        preHandler: app.authenticate,
        schema: { params: accessParams, response: { 200: ArtifactAccessRecipientCensusResponseV1Schema, ...accessErrors } },
    }, async (request, reply) => {
        const result = await inTx(tx => readArtifactRecipientCensusInTx(tx, { actorAccountId: request.userId, artifactId: request.params.id }));
        return result.ok ? reply.send(result.value) : reply.code(accessErrorStatus(result.error)).send({ error: result.error });
    });
    app.post('/v1/artifacts/:id/access/key-envelopes', {
        preHandler: app.authenticate,
        schema: { params: accessParams, body: ArtifactRecipientKeyEnvelopeCommitInputV1Schema,
            response: { 200: ArtifactRecipientKeyEnvelopeCommitResponseV1Schema, ...accessErrors } },
    }, async (request, reply) => {
        if (request.body.artifactId !== request.params.id) return reply.code(400).send({ error: "artifact_not_found" });
        const result = await inTx(tx => commitArtifactRecipientKeyEnvelopesInTx(tx, { ...request.body, actorAccountId: request.userId }));
        return result.ok ? reply.send(result.value) : reply.code(accessErrorStatus(result.error)).send({ error: result.error });
    });

    // POST /v1/artifacts - Create new artifact
    const registerCreateArtifactRoute = (url: string, requiresBlob: boolean) => app.post(url, {
        preHandler: app.authenticate,
        schema: {
            body: z.object({
                id: z.string().uuid(),
                header: z.string(),
                body: z.string(),
                dataEncryptionKey: z.string(),
                blob: ArtifactBlobWriteV1Schema.optional(),
            }).strict().refine(value => requiresBlob ? value.blob !== undefined : value.blob === undefined),
            response: {
                200: z.object({
                    id: z.string(),
                    header: z.string(),
                    headerVersion: z.number(),
                    body: z.string(),
                    bodyVersion: z.number(),
                    dataEncryptionKey: z.string(),
                    seq: z.number(),
                    createdAt: z.number(),
                    updatedAt: z.number(),
                    ownerAccountId: z.string(),
                    access: ArtifactCallerAccessV1Schema,
                    encryptionMode: ArtifactAccessRecipientCensusResponseV1Schema.shape.encryptionMode,
                }),
                409: z.object({
                    error: z.literal('Artifact with this ID already exists for another account')
                }),
                413: ArtifactQuotaExceededV1Schema,
                400: z.object({
                    error: z.literal('Invalid parameters')
                }),
                500: z.object({
                    error: z.literal('Failed to create artifact')
                })
            }
        }
    }, async (request, reply) => {
        const result = await createArtifactHttpMutation(request.userId, request.body);
        return reply.code(result.statusCode).send(result.body);
    });

    registerCreateArtifactRoute('/v1/artifacts', false);
    registerCreateArtifactRoute('/v1/artifacts/content/binary', true);

    // Both transports use the same canonical body-version mutation owner.
    const registerUpdateArtifactRoute = (url: string, requiresBlob: boolean) => app.post(url, {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                id: z.string()
            }),
            body: z.object({
                header: z.string().optional(),
                expectedHeaderVersion: z.number().int().min(0).optional(),
                body: z.string().optional(),
                expectedBodyVersion: z.number().int().min(0).optional(),
                blob: ArtifactBlobWriteV1Schema.nullable().optional(),
            }).strict().refine(value => requiresBlob ? value.blob !== undefined : value.blob === undefined),
            response: {
                200: z.union([
                    z.object({
                        success: z.literal(true),
                        headerVersion: z.number().optional(),
                        bodyVersion: z.number().optional()
                    }),
                    z.object({
                        success: z.literal(false),
                        error: z.literal('version-mismatch'),
                        currentHeaderVersion: z.number().optional(),
                        currentBodyVersion: z.number().optional(),
                        currentHeader: z.string().optional(),
                        currentBody: z.string().optional()
                    })
                ]),
                400: z.object({
                    error: z.literal('Invalid parameters')
                }),
                404: z.object({
                    error: z.literal('Artifact not found')
                }),
                409: z.object({ error: z.literal('artifact_binary_content_requires_explicit_update') }),
                413: ArtifactQuotaExceededV1Schema,
                500: z.object({
                    error: z.literal('Failed to update artifact')
                })
            }
        }
    }, async (request, reply) => {
        const result = await updateArtifactHttpMutation(request.userId, request.params.id, request.body);
        return reply.code(result.statusCode).send(result.body);
    });

    registerUpdateArtifactRoute('/v1/artifacts/:id', false);
    registerUpdateArtifactRoute('/v1/artifacts/:id/content/binary', true);

    // DELETE /v1/artifacts/:id - Delete artifact
    const registerDeleteArtifactRoute = (url: string, requiresRevision: boolean) => app.delete(url, {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                id: z.string(),
                expectedHeaderVersion: z.coerce.number().int().nonnegative().optional(),
                expectedBodyVersion: z.coerce.number().int().nonnegative().optional(),
            }).strict().refine((params) => !requiresRevision
                || (params.expectedHeaderVersion !== undefined && params.expectedBodyVersion !== undefined)),
            response: {
                200: z.object({
                    success: z.literal(true)
                }),
                404: z.object({
                    error: z.literal('Artifact not found')
                }),
                409: z.object({ error: z.literal('version-mismatch') }),
                500: z.object({
                    error: z.literal('Failed to delete artifact')
                })
            }
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { id } = request.params;

        try {
            const result = await deleteArtifact({
                actorUserId: userId,
                artifactId: id,
                ...(request.params.expectedHeaderVersion !== undefined && request.params.expectedBodyVersion !== undefined
                    ? { expectedRevision: { headerVersion: request.params.expectedHeaderVersion, bodyVersion: request.params.expectedBodyVersion } } : {}),
            });
            if (!result.ok) {
                if (result.error === 'version-mismatch') return reply.code(409).send({ error: 'version-mismatch' });
                if (result.error === 'not-found') {
                    return reply.code(404).send({ error: 'Artifact not found' });
                }

                return reply.code(500).send({ error: 'Failed to delete artifact' });
            }

            const deletePayload = buildDeleteArtifactUpdate(id, result.cursor, randomKeyNaked(12));
            eventRouter.emitUpdate({
                userId,
                payload: deletePayload,
                recipientFilter: { type: 'user-scoped-only' }
            });

            return reply.send({ success: true });
        } catch (error) {
            log({ module: 'api', level: 'error' }, `Failed to delete artifact: ${error}`);
            return reply.code(500).send({ error: 'Failed to delete artifact' });
        }
    });
    registerDeleteArtifactRoute('/v1/artifacts/:id', false);
    registerDeleteArtifactRoute('/v1/artifacts/:id/revision/:expectedHeaderVersion/:expectedBodyVersion', true);
}
