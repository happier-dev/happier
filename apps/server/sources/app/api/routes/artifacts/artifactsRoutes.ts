import { ArtifactTemplateAcceptedVersionInputV1Schema, ArtifactTemplateAcceptedVersionResponseV1Schema } from '@happier-dev/protocol/artifacts/artifactAccessV1';
import { createArtifactHttpMutation, updateArtifactHttpMutation } from '@/app/artifacts/artifactMutationHttpResponse';
import { ARTIFACT_LIST_PAGE_MAX_ITEMS_V1 } from '@happier-dev/protocol/artifacts/artifactListSelectionV1';
import { registerArtifactUploadRoutes } from './registerArtifactUploadRoutes';
import { ArtifactCoarseKindV1Schema, ArtifactStoredKindV1Schema, ArtifactKindWriteBatchInputV1Schema,
    ArtifactKindWriteBatchResponseV1Schema, ArtifactKindCoverageV1Schema, type ArtifactKindWriteBatchResponseV1, type ArtifactCoarseKindV1 } from '@happier-dev/protocol/artifacts/artifactKindV1';
import { createServerFeatureGatedRouteApp } from '@/app/features/catalog/serverFeatureGate';
import { registerArtifactEditProposalRoutes } from './artifactEditProposalRoutes';
import { readArtifactAccountEncryptionMigrationInventoryInTx } from '@/app/artifacts/artifactAccountEncryptionMigrationInventory';
import { eventRouter, buildNewArtifactUpdate, buildUpdateArtifactUpdate, buildDeleteArtifactUpdate } from "@/app/events/eventRouter";
import { inReadSnapshot, inTx } from "@/storage/inTx";
import {
    commitArtifactRecipientKeyEnvelopesInTx,
    listArtifactAccessGrants,
    listArtifactHeaderPageForCaller,
    readArtifactForCaller,
    readArtifactBatchForCaller,
    readArtifactRecipientCensus,
    removeArtifactAccessGrantInTx,
    setArtifactAccessGrantInTx,
    reportArtifactTemplateAcceptedVersionInTx,
    type ArtifactForCaller,
    type ArtifactListItemForCaller,
} from "@/app/artifacts/artifactAccessService";
import { ArtifactHttpReadV1Schema, ArtifactReadBatchHttpInputV1Schema, ArtifactReadBatchHttpResponseV1Schema,
    type ArtifactReadBatchResponseV1, type ArtifactReadHeadersBatchResponseV1 } from '@happier-dev/protocol/artifacts/artifactAccessV1';
import { Fastify } from "../../types";
import { z } from "zod/mini";
import { randomKeyNaked } from "@/utils/keys/randomKeyNaked";
import { log } from "@/utils/logging/log";
import * as privacyKit from "privacy-kit";
import { createArtifact, deleteArtifact, updateArtifact } from "@/app/artifacts/artifactWriteService";
import { listArtifactBodyRevisions, restoreArtifactBodyRevision } from "@/app/artifacts/artifactRevisionService";
import { ArtifactStorageSizeUnavailableError, readArtifactStorageUsageInTx } from "@/app/artifacts/artifactStorageService";
import { readArtifactBlob } from '@/app/artifacts/artifactBlobService';
import { resolveIsolatedStoredContentPublicShareOrigin } from '@/app/share/storedContentPublicShareOrigin';
import { registerArtifactHtmlViewerRoutes } from '../share/registerPublicShareViewerRoutes';
import { readHomeConfigEnv } from '@/app/home/settings/homeSettings';
import { resolveApiHotEndpointRateLimit } from "@/app/api/utils/apiRateLimitCatalog";
import { ArtifactCallerAccessV1Schema, ArtifactAccessGrantSetStorageInputV1Schema, ArtifactAccessGrantRemoveInputV1Schema, ArtifactAccessGrantsListResponseV1Schema, ArtifactAccessGrantMutationResponseV1Schema, ArtifactAccessRecipientCensusResponseV1Schema, ArtifactRecipientKeyEnvelopeCommitInputV1Schema, ArtifactRecipientKeyEnvelopeCommitResponseV1Schema, ArtifactAccessErrorCodeV1Schema } from '@happier-dev/protocol/artifacts/artifactAccessV1';
import { ArtifactRevisionListResponseV1Schema, ArtifactStorageUsageV1Schema, ArtifactQuotaExceededV1Schema } from '@happier-dev/protocol/artifacts/artifactActionsV1';
import { ArtifactBlobWriteV1Schema, ArtifactBlobReadResponseV1Schema } from '@happier-dev/protocol/artifacts/artifactBinaryV1';
import { ArtifactHtmlPreviewResponseV1Schema } from '@happier-dev/protocol/artifacts/artifactHtmlV1';
import { ArtifactAccountEncryptionMigrationInventoryV1Schema } from '@happier-dev/protocol/artifacts/artifactAccountEncryptionMigrationV1';
import { CoordinationMessageRefV1Schema } from '@happier-dev/protocol/discussions/messageRefs';
import { readSessionAccessAuthenticationFromRequest } from '@/app/session/access/sessionAccessAuthentication';
import { ApprovalArtifactQueryHintsV1Schema, ApprovalArtifactStateV1Schema, type ApprovalArtifactStateV1 } from '@happier-dev/protocol/approvals/approvalArtifactKindV1';

const DEFAULT_ARTIFACT_LIST_LIMIT = ARTIFACT_LIST_PAGE_MAX_ITEMS_V1;

const artifactListItemSchema = z.object({
    id: z.string(), kind: z.nullable(ArtifactCoarseKindV1Schema), header: z.string(), headerVersion: z.number(),
    kindHint: z.optional(z.nullable(z.string())),
    body: z.optional(z.string()), bodyVersion: z.number(), provenance: z.optional(z.nullable(z.string())),
    provenanceDataEncryptionKey: z.optional(z.nullable(z.string())), dataEncryptionKey: z.string(), seq: z.number(),
    createdAt: z.number(), updatedAt: z.number(), ownerAccountId: z.string(), access: ArtifactCallerAccessV1Schema,
    publicAudience: z.enum(['retained', 'none']),
    encryptionMode: ArtifactAccessRecipientCensusResponseV1Schema.shape.encryptionMode,
});

function projectArtifactListItem(artifact: ArtifactListItemForCaller) {
    return {
        id: artifact.id, kind: artifact.kind, ...(artifact.kindHint === undefined ? {} : { kindHint: artifact.kindHint }), ownerAccountId: artifact.ownerAccountId, access: artifact.access,
        publicAudience: artifact.publicAudience,
        encryptionMode: artifact.encryptionMode, header: privacyKit.encodeBase64(artifact.header), headerVersion: artifact.headerVersion,
        ...(artifact.body === undefined ? {} : { body: privacyKit.encodeBase64(artifact.body) }), bodyVersion: artifact.bodyVersion,
        provenance: artifact.provenance ? privacyKit.encodeBase64(artifact.provenance) : null,
        provenanceDataEncryptionKey: artifact.provenanceDataEncryptionKey ? privacyKit.encodeBase64(artifact.provenanceDataEncryptionKey) : null,
        dataEncryptionKey: privacyKit.encodeBase64(artifact.dataEncryptionKey), seq: artifact.seq,
        createdAt: artifact.createdAt.getTime(), updatedAt: artifact.updatedAt.getTime(),
    };
}

/** Both read transports project the same caller-authorized bytes and exposure facts. */
function projectArtifactHttpRead(artifact: ArtifactForCaller & { publicAudience: 'retained' | 'none' }) {
    return {
        id: artifact.id, kind: artifact.kind, ...(artifact.kindHint === undefined ? {} : { kindHint: artifact.kindHint }), ownerAccountId: artifact.ownerAccountId, access: artifact.access, encryptionMode: artifact.encryptionMode,
        header: privacyKit.encodeBase64(artifact.header), headerVersion: artifact.headerVersion,
        body: privacyKit.encodeBase64(artifact.body), bodyVersion: artifact.bodyVersion, publicAudience: artifact.publicAudience,
        provenance: artifact.provenance ? privacyKit.encodeBase64(artifact.provenance) : null,
        provenanceDataEncryptionKey: artifact.provenanceDataEncryptionKey ? privacyKit.encodeBase64(artifact.provenanceDataEncryptionKey) : null,
        dataEncryptionKey: privacyKit.encodeBase64(artifact.dataEncryptionKey), seq: artifact.seq,
        createdAt: artifact.createdAt.getTime(), updatedAt: artifact.updatedAt.getTime(),
    };
}

/** Retain the exact read's owner recovery versus granted-caller refusal semantics. */
function projectArtifactHttpReadFailure(read: Readonly<{
    error: 'artifact_not_found' | 'artifact_content_unavailable'; ownerAccountId?: string;
}>, actorAccountId: string) {
    if (read.error === 'artifact_not_found') return { status: 404 as const, error: 'Artifact not found' as const, retryable: false };
    if (read.ownerAccountId === actorAccountId) return { status: 500 as const, error: 'Failed to get artifact' as const, retryable: true };
    return { status: 409 as const, error: 'artifact_content_unavailable' as const, retryable: false };
}

function artifactAccessHttpFailureStatus(error: string) {
    return error === 'artifact_not_found' ? 404 as const
        : error === 'artifact_access_forbidden' ? 403 as const
            : error === 'artifact_content_unavailable' || error === 'artifact_data_key_changed' ? 409 as const : 400 as const;
}

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
    registerArtifactEditProposalRoutes(app);
    registerArtifactUploadRoutes(app);
    registerArtifactHtmlViewerRoutes(app);
    app.get('/v1/account/encryption/artifacts', {
        preHandler: app.authenticate,
        config: { rateLimit: resolveApiHotEndpointRateLimit(process.env, 'artifacts') },
        schema: { querystring: z.strictObject({ afterId: z.optional(z.string().check(z.minLength(1))),
            limit: z.optional(z.coerce.number().check(z.int(), z.minimum(1), z.maximum(DEFAULT_ARTIFACT_LIST_LIMIT))) }),
            response: { 200: ArtifactAccountEncryptionMigrationInventoryV1Schema,
                503: z.strictObject({ error: z.literal('artifact_content_unavailable') }) } },
    }, async (request, reply) => {
        const inventory = await inReadSnapshot(tx => readArtifactAccountEncryptionMigrationInventoryInTx({ tx, accountId: request.userId,
            afterId: request.query.afterId, limit: request.query.limit ?? DEFAULT_ARTIFACT_LIST_LIMIT }));
        return inventory ? reply.send(inventory) : reply.code(503).send({ error: 'artifact_content_unavailable' });
    });
    app.get('/v1/artifacts/:id/html-preview', {
        preHandler: app.authenticate,
        config: { rateLimit: resolveApiHotEndpointRateLimit(process.env, 'artifacts') },
        schema: { params: z.strictObject({ id: z.string().check(z.minLength(1)) }), response: {
            200: ArtifactHtmlPreviewResponseV1Schema,
            404: z.object({ error: z.literal('Artifact not found') }),
            503: z.object({ error: z.enum(['artifact_content_unavailable', 'artifact_html_isolation_unavailable']) }),
        } },
    }, async (request, reply) => {
        const read = await readArtifactForCaller({ actorAccountId: request.userId, artifactId: request.params.id });
        if (!read.ok) return read.error === 'artifact_not_found'
            ? reply.code(404).send({ error: 'Artifact not found' }) : reply.code(503).send({ error: 'artifact_content_unavailable' });
        const origin = resolveIsolatedStoredContentPublicShareOrigin(request.params.id, await readHomeConfigEnv());
        if (!origin) return reply.code(503).send({ error: 'artifact_html_isolation_unavailable' });
        return reply.send({ url: `${origin}/a/${encodeURIComponent(request.params.id)}` });
    });
    app.get('/v1/artifacts/:id/blobs/:blobId', {
        preHandler: app.authenticate,
        config: { rateLimit: resolveApiHotEndpointRateLimit(process.env, 'artifacts') },
        schema: { params: z.object({ id: z.string(), blobId: z.string().check(z.uuid()) }), response: {
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
        try { return reply.send(await inReadSnapshot(tx => readArtifactStorageUsageInTx(tx, request.userId))); }
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
        const result = await listArtifactBodyRevisions({ actorAccountId: request.userId, artifactId: request.params.id });
        if (!result.ok) return result.error === 'artifact_not_found'
            ? reply.code(404).send({ error: 'Artifact not found' })
            : reply.code(503).send({ error: 'artifact_content_unavailable' });
        return reply.send({ retentionCount: result.retentionCount, revisions: result.revisions.map(revision => ({
            ...revision, body: privacyKit.encodeBase64(revision.body), createdAt: revision.createdAt.getTime(),
            provenance: revision.provenance ? privacyKit.encodeBase64(revision.provenance) : null,
        })) });
    });

    app.post('/v1/artifacts/:id/revisions/:bodyVersion/restore', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ id: z.string(), bodyVersion: z.coerce.number().check(z.int(), z.minimum(1)) }),
            body: z.strictObject({ header: z.string(), body: z.optional(z.string()), kind: z.optional(ArtifactStoredKindV1Schema),
                provenance: z.optional(z.nullable(z.string())), provenanceDataEncryptionKey: z.optional(z.nullable(z.string())),
                expectedHeaderVersion: z.number().check(z.int(), z.minimum(1)), expectedBodyVersion: z.number().check(z.int(), z.minimum(1)) }),
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
            kind: request.body.kind,
            bodyVersion: request.params.bodyVersion, header: privacyKit.decodeBase64(request.body.header),
            ...(request.body.body !== undefined ? { body: privacyKit.decodeBase64(request.body.body) } : {}),
            ...(request.body.provenance == null ? {} : { provenance: privacyKit.decodeBase64(request.body.provenance) }),
            ...(request.body.provenanceDataEncryptionKey == null ? {} : { provenanceDataEncryptionKey: privacyKit.decodeBase64(request.body.provenanceDataEncryptionKey) }),
            expectedRevision: { headerVersion: request.body.expectedHeaderVersion,
                bodyVersion: request.body.expectedBodyVersion } });
        if (!result.ok) {
            if (result.error === 'quota_exceeded') return reply.code(413).send({ error: result.error, budget: result.budget, limitBytes: result.limitBytes, usedBytes: result.usedBytes });
            if (result.error === 'not-found') return reply.code(404).send({ error: 'Artifact not found' });
            if (result.error === 'invalid-params') return reply.code(400).send({ error: 'Invalid parameters' });
            if (result.error === 'version-mismatch' && result.current?.body !== undefined) return reply.send({ success: false as const,
                error: 'version-mismatch' as const, currentHeaderVersion: result.current.headerVersion, currentBodyVersion: result.current.bodyVersion,
                currentHeader: privacyKit.encodeBase64(new Uint8Array(result.current.header)), currentBody: privacyKit.encodeBase64(new Uint8Array(result.current.body)) });
            return reply.code(500).send({ error: 'Failed to restore artifact' });
        }
        if (!result.header || !result.body) return reply.code(500).send({ error: 'Failed to restore artifact' });
        for (const recipient of result.recipientUpdates) {
            eventRouter.emitUpdate({ userId: recipient.accountId,
                payload: buildUpdateArtifactUpdate(request.params.id, recipient.cursor.resolveCursor(), randomKeyNaked(12),
                    { value: privacyKit.encodeBase64(new Uint8Array(result.header.bytes)), version: result.header.version },
                    { value: privacyKit.encodeBase64(new Uint8Array(result.body.bytes)), version: result.body.version }, recipient),
                recipientFilter: { type: 'user-scoped-only' } });
        }
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
                limit: z.optional(z.coerce.number().check(z.int(), z.minimum(1), z.maximum(ARTIFACT_LIST_PAGE_MAX_ITEMS_V1))),
                cursor: z.optional(z.string().check(z.minLength(1))),
                includeBody: z.optional(z.literal('true')),
                ownerAccountId: z.optional(z.string()),
                audience: z.optional(z.literal('received')),
                kind: z.optional(ArtifactCoarseKindV1Schema),
                kinds: z.optional(z.string()),
                approvalStates: z.optional(z.string()),
                approvalSessionIds: z.optional(z.string()),
                browserListed: z.optional(z.literal('true')),
                unclassified: z.optional(z.enum(['true', 'coarse', 'approval'])),
            }),
            response: {
                200: z.union([z.array(artifactListItemSchema), z.object({ items: z.array(artifactListItemSchema), hasUnclassified: z.boolean(),
                    coverage: z.optional(ArtifactKindCoverageV1Schema) })]),
                400: z.object({ error: z.literal('Failed to get artifacts') }),
            }
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const query = request.query as { limit?: number; cursor?: string; includeBody?: 'true'; ownerAccountId?: string; audience?: 'received';
            kind?: ArtifactCoarseKindV1; kinds?: string; approvalStates?: string; approvalSessionIds?: string;
            browserListed?: 'true'; unclassified?: 'true' | 'coarse' | 'approval' };
        const listLimit = typeof query.limit === "number" ? query.limit : DEFAULT_ARTIFACT_LIST_LIMIT;
        const cursor = parseArtifactListCursor(query.cursor);
        if (query.cursor && !cursor) return reply.code(400).send({ error: 'Failed to get artifacts' });
        if ([query.kind !== undefined, query.kinds !== undefined, query.browserListed !== undefined, query.unclassified !== undefined].filter(Boolean).length > 1
            || (query.unclassified !== undefined && query.includeBody === 'true')) return reply.code(400).send({ error: 'Failed to get artifacts' });
        let kinds: string[] | undefined;
        let approvalStates: ApprovalArtifactStateV1[] | undefined;
        let approvalSessionIds: string[] | undefined;
        if (query.approvalSessionIds !== undefined) {
            try {
                const parsed = z.array(z.string().check(z.minLength(1))).safeParse(JSON.parse(query.approvalSessionIds));
                if (!parsed.success) return reply.code(400).send({ error: 'Failed to get artifacts' });
                approvalSessionIds = parsed.data;
            } catch { return reply.code(400).send({ error: 'Failed to get artifacts' }); }
        }
        if (query.approvalStates !== undefined) {
            try {
                const parsed = z.array(ApprovalArtifactStateV1Schema).safeParse(JSON.parse(query.approvalStates));
                if (!parsed.success) return reply.code(400).send({ error: 'Failed to get artifacts' });
                approvalStates = parsed.data;
            } catch { return reply.code(400).send({ error: 'Failed to get artifacts' }); }
        }
        if (query.kinds !== undefined) {
            try {
                const parsed = z.array(z.string().check(z.minLength(1))).safeParse(JSON.parse(query.kinds));
                if (!parsed.success) return reply.code(400).send({ error: 'Failed to get artifacts' });
                kinds = parsed.data;
            } catch { return reply.code(400).send({ error: 'Failed to get artifacts' }); }
        }

        const page = await listArtifactHeaderPageForCaller({ actorAccountId: userId, limit: listLimit, cursor,
            includeBody: query.includeBody === 'true', ownerAccountId: query.ownerAccountId, audience: query.audience, kind: query.kind, kinds,
            approvalStates, approvalSessionIds,
            ...(query.browserListed ? { browserListed: true } : {}),
            unclassified: query.unclassified === 'coarse' || query.unclassified === 'approval' ? query.unclassified : query.unclassified === 'true' });

        const projected = page.items.map(projectArtifactListItem);
        if (query.kind === undefined && kinds === undefined && query.browserListed === undefined && query.unclassified === undefined
            && approvalStates === undefined && approvalSessionIds === undefined && query.audience === undefined) return reply.send(projected);
        return reply.send({ items: projected, hasUnclassified: page.hasUnclassified,
            ...(kinds !== undefined || query.browserListed !== undefined || query.unclassified !== undefined
                || approvalStates !== undefined || approvalSessionIds !== undefined || query.audience !== undefined ? { coverage: page.coverage } : {}) });
    });

    // A transport batch reuses independent canonical CAS transactions and publication.
    createServerFeatureGatedRouteApp(app, 'artifacts.queryHints').post('/v1/artifacts/query-hints/batch', {
        preHandler: app.authenticate,
        schema: { body: ArtifactKindWriteBatchInputV1Schema, response: { 200: ArtifactKindWriteBatchResponseV1Schema,
            404: z.object({ error: z.literal('not_found') }) } },
    }, async (request, reply) => {
        const items: ArtifactKindWriteBatchResponseV1['items'] = [];
        for (const item of request.body.items) {
            const result = await updateArtifactHttpMutation(request.userId, item.artifactId,
                { kind: item.kind, approvalState: item.approvalState, approvalSessionId: item.approvalSessionId,
                    expectedHeaderVersion: item.expectedHeaderVersion });
            items.push('success' in result.body && result.body.success
                ? { artifactId: item.artifactId, success: true }
                : { artifactId: item.artifactId, success: false, error: 'error' in result.body
                    ? result.body.error : 'Failed to update artifact' });
        }
        return reply.send({ items });
    });

    // Selected details and current recipient facts share a read-only capture.
    app.post('/v1/artifacts/read', {
        preHandler: app.authenticate,
        config: { rateLimit: resolveApiHotEndpointRateLimit(process.env, 'artifacts') },
        schema: { body: ArtifactReadBatchHttpInputV1Schema, response: { 200: ArtifactReadBatchHttpResponseV1Schema } },
    }, async (request, reply) => {
        const projection = 'projection' in request.body ? request.body.projection : undefined;
        const captured = await readArtifactBatchForCaller({ actorAccountId: request.userId,
            artifactIds: request.body.artifactIds, projection });
        const response: ArtifactReadBatchResponseV1 | ArtifactReadHeadersBatchResponseV1 = projection === 'headers'
            ? { projection, items: [] } : { items: [] };
        for (const { artifactId, read, census } of captured) {
            if (!read.ok) {
                const refusal = projectArtifactHttpReadFailure(read, request.userId);
                response.items.push({ artifactId, ok: false, error: read.error, status: refusal.status, retryable: refusal.retryable });
                continue;
            }
            if (census && !census.ok) {
                // The incumbent recipient API rejects with a generic typed Error,
                // which the existing retry owner retries; preserve that classification.
                response.items.push({ artifactId, ok: false, error: census.error,
                    status: artifactAccessHttpFailureStatus(census.error), retryable: true });
                continue;
            }
            if ('projection' in response) {
                response.items.push({ artifactId, ok: true, artifact: projectArtifactListItem(read.artifact) });
                continue;
            }
            if (read.artifact.body === undefined) throw new Error('Full Artifact read did not capture its body');
            response.items.push({ artifactId, ok: true, artifact: projectArtifactHttpRead({ ...read.artifact, body: read.artifact.body }),
                recipientCensus: census?.value ?? null });
        }
        return reply.send(response);
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
                200: ArtifactHttpReadV1Schema,
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

        const read = await readArtifactForCaller({ actorAccountId: userId, artifactId: id });
        if (!read.ok) {
            const refusal = projectArtifactHttpReadFailure(read, userId);
            return reply.code(refusal.status).send({ error: refusal.error });
        }
        return reply.send(projectArtifactHttpRead(read.artifact));
    });

    const accessParams = z.strictObject({ id: z.string().check(z.minLength(1)) });
    const accessError = z.strictObject({ error: ArtifactAccessErrorCodeV1Schema });
    const accessErrors = { 400: accessError, 403: accessError, 404: accessError, 409: accessError };
    const accessErrorStatus = artifactAccessHttpFailureStatus;
    app.put('/v1/artifacts/:id/access/accepted-version', {
        preHandler: app.authenticate,
        schema: { params: accessParams, body: ArtifactTemplateAcceptedVersionInputV1Schema,
            response: { 200: ArtifactTemplateAcceptedVersionResponseV1Schema, ...accessErrors } },
    }, async (request, reply) => {
        if (request.body.artifactId !== request.params.id) return reply.code(400).send({ error: 'artifact_not_found' });
        const result = await inTx(tx => reportArtifactTemplateAcceptedVersionInTx(tx, { ...request.body, actorAccountId: request.userId }), {
            transactionClass: 'artifact-template-accepted-version',
        });
        return result.ok ? reply.send(result.value) : reply.code(accessErrorStatus(result.error)).send({ error: result.error });
    });

    app.get('/v1/artifacts/:id/access/grants', {
        preHandler: app.authenticate,
        schema: { params: accessParams, response: { 200: ArtifactAccessGrantsListResponseV1Schema, ...accessErrors } },
    }, async (request, reply) => {
        const result = await listArtifactAccessGrants({ actorAccountId: request.userId, artifactId: request.params.id });
        return result.ok ? reply.send(result.value) : reply.code(accessErrorStatus(result.error)).send({ error: result.error });
    });
    app.put('/v1/artifacts/:id/access/grants', {
        preHandler: app.authenticate,
        schema: { params: accessParams, body: ArtifactAccessGrantSetStorageInputV1Schema,
            response: { 200: ArtifactAccessGrantMutationResponseV1Schema, ...accessErrors } },
    }, async (request, reply) => {
        if (request.body.artifactId !== request.params.id) return reply.code(400).send({ error: "artifact_not_found" });
        // The Artifact owner admits and rechecks the audience before its parent
        // lock, fencing mode/key changes. A Serializable snapshot instead goes
        // stale whenever a peer publishes on those same Account rows.
        const result = await inTx(tx => setArtifactAccessGrantInTx(tx, { ...request.body, actorAccountId: request.userId }), {
            isolationLevel: "ReadCommitted", transactionClass: "artifact-access-grant-set",
        });
        return result.ok ? reply.send(result.value) : reply.code(accessErrorStatus(result.error)).send({ error: result.error });
    });
    app.delete('/v1/artifacts/:id/access/grants', {
        preHandler: app.authenticate,
        schema: { params: accessParams, body: ArtifactAccessGrantRemoveInputV1Schema,
            response: { 200: ArtifactAccessGrantMutationResponseV1Schema, ...accessErrors } },
    }, async (request, reply) => {
        if (request.body.artifactId !== request.params.id) return reply.code(400).send({ error: "artifact_not_found" });
        const result = await inTx(tx => removeArtifactAccessGrantInTx(tx, { ...request.body, actorAccountId: request.userId }), {
            isolationLevel: "ReadCommitted", transactionClass: "artifact-access-grant-remove",
        });
        return result.ok ? reply.send(result.value) : reply.code(accessErrorStatus(result.error)).send({ error: result.error });
    });
    app.get('/v1/artifacts/:id/access/recipients', {
        preHandler: app.authenticate,
        schema: { params: accessParams, response: { 200: ArtifactAccessRecipientCensusResponseV1Schema, ...accessErrors } },
    }, async (request, reply) => {
        const result = await readArtifactRecipientCensus({ actorAccountId: request.userId, artifactId: request.params.id });
        return result.ok ? reply.send(result.value) : reply.code(accessErrorStatus(result.error)).send({ error: result.error });
    });
    app.post('/v1/artifacts/:id/access/key-envelopes', {
        preHandler: app.authenticate,
        schema: { params: accessParams, body: ArtifactRecipientKeyEnvelopeCommitInputV1Schema,
            response: { 200: ArtifactRecipientKeyEnvelopeCommitResponseV1Schema, ...accessErrors } },
    }, async (request, reply) => {
        if (request.body.artifactId !== request.params.id) return reply.code(400).send({ error: "artifact_not_found" });
        const result = await inTx(tx => commitArtifactRecipientKeyEnvelopesInTx(tx, { ...request.body, actorAccountId: request.userId }), {
            isolationLevel: "ReadCommitted", transactionClass: "artifact-recipient-key-envelopes-commit",
        });
        return result.ok ? reply.send(result.value) : reply.code(accessErrorStatus(result.error)).send({ error: result.error });
    });

    // POST /v1/artifacts - Create new artifact
    const registerCreateArtifactRoute = (url: string, requiresBlob: boolean, requiresMemoryDecisionSource = false) => app.post(url, {
        preHandler: app.authenticate,
        schema: {
            body: z.strictObject({
                id: z.string().check(z.uuid()),
                kind: z.optional(ArtifactStoredKindV1Schema),
                approvalState: z.optional(ApprovalArtifactQueryHintsV1Schema.shape.approvalState),
                approvalSessionId: z.optional(ApprovalArtifactQueryHintsV1Schema.shape.approvalSessionId),
                header: z.string(),
                body: z.string(),
                dataEncryptionKey: z.string(),
                blob: z.optional(ArtifactBlobWriteV1Schema),
                memoryDecisionSource: requiresMemoryDecisionSource ? CoordinationMessageRefV1Schema : z.optional(z.never()),
                provenance: z.optional(z.nullable(z.string())),
                provenanceDataEncryptionKey: z.optional(z.nullable(z.string())),
            }).check(z.refine(value => requiresBlob ? value.blob !== undefined : value.blob === undefined)),
            response: {
                200: z.object({
                    id: z.string(),
                    kind: z.nullable(ArtifactCoarseKindV1Schema),
                    kindHint: z.optional(z.nullable(z.string())),
                    header: z.string(),
                    headerVersion: z.number(),
                    body: z.string(),
                    bodyVersion: z.number(),
                    provenance: z.optional(z.nullable(z.string())),
                    provenanceDataEncryptionKey: z.optional(z.nullable(z.string())),
                    dataEncryptionKey: z.string(),
                    seq: z.number(),
                    createdAt: z.number(),
                    updatedAt: z.number(),
                    ownerAccountId: z.string(),
                    access: ArtifactCallerAccessV1Schema,
                    encryptionMode: ArtifactAccessRecipientCensusResponseV1Schema.shape.encryptionMode,
                }),
                403: z.object({ error: z.string() }),
                404: z.object({ error: z.literal('memory_decision_source_unavailable') }),
                409: z.object({ error: z.enum(['Artifact with this ID already exists for another account', 'memory_decision_source_unsupported']) }),
                413: ArtifactQuotaExceededV1Schema,
                400: z.object({
                    error: z.literal('Invalid parameters')
                }),
                500: z.object({
                    error: z.literal('Failed to create artifact')
                }),
                503: z.object({ error: z.enum(['database_transaction_conflict_exhausted', 'database_connection_unavailable']), statusCode: z.literal(503) }),
            }
        }
    }, async (request, reply) => {
        const result = await createArtifactHttpMutation(request.userId, request.body,
            request.body.memoryDecisionSource === undefined ? undefined : readSessionAccessAuthenticationFromRequest(request));
        return reply.code(result.statusCode).send(result.body);
    });

    registerCreateArtifactRoute('/v1/artifacts', false);
    registerCreateArtifactRoute('/v1/artifacts/content/binary', true);
    registerCreateArtifactRoute('/v1/artifacts/memory-decision/create', false, true);

    // Both transports use the same canonical body-version mutation owner.
    const registerUpdateArtifactRoute = (url: string, requiresBlob: boolean, requiresMemoryDecisionSource = false) => app.post(url, {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                id: z.string()
            }),
            body: z.strictObject({
                header: z.optional(z.string()),
                kind: z.optional(ArtifactStoredKindV1Schema),
                approvalState: z.optional(ApprovalArtifactQueryHintsV1Schema.shape.approvalState),
                approvalSessionId: z.optional(ApprovalArtifactQueryHintsV1Schema.shape.approvalSessionId),
                expectedHeaderVersion: z.optional(z.number().check(z.int(), z.minimum(0))),
                body: z.optional(z.string()),
                expectedBodyVersion: z.optional(z.number().check(z.int(), z.minimum(0))),
                provenance: z.optional(z.nullable(z.string())),
                provenanceDataEncryptionKey: z.optional(z.nullable(z.string())),
                blob: z.optional(z.nullable(ArtifactBlobWriteV1Schema)),
                memoryDecisionSource: requiresMemoryDecisionSource ? CoordinationMessageRefV1Schema : z.optional(z.never()),
            }).check(z.refine(value => requiresBlob ? value.blob !== undefined : value.blob === undefined)),
            response: {
                200: z.union([
                    z.object({
                        success: z.literal(true),
                        headerVersion: z.optional(z.number()),
                        bodyVersion: z.optional(z.number())
                    }),
                    z.object({
                        success: z.literal(false),
                        error: z.literal('version-mismatch'),
                        currentHeaderVersion: z.optional(z.number()),
                        currentBodyVersion: z.optional(z.number()),
                        currentHeader: z.optional(z.string()),
                        currentBody: z.optional(z.string())
                    })
                ]),
                400: z.object({
                    error: z.literal('Invalid parameters')
                }),
                403: z.object({ error: z.string() }),
                404: z.object({ error: z.enum(['Artifact not found', 'memory_decision_source_unavailable']) }),
                409: z.object({ error: z.enum(['artifact_binary_content_requires_explicit_update', 'memory_decision_source_unsupported']) }),
                413: ArtifactQuotaExceededV1Schema,
                500: z.object({
                    error: z.literal('Failed to update artifact')
                }),
                503: z.object({ error: z.enum(['database_transaction_conflict_exhausted', 'database_connection_unavailable']), statusCode: z.literal(503) }),
            }
        }
    }, async (request, reply) => {
        const result = await updateArtifactHttpMutation(request.userId, request.params.id, request.body,
            request.body.memoryDecisionSource === undefined ? undefined : readSessionAccessAuthenticationFromRequest(request));
        return reply.code(result.statusCode).send(result.body);
    });

    registerUpdateArtifactRoute('/v1/artifacts/:id', false);
    registerUpdateArtifactRoute('/v1/artifacts/:id/content/binary', true);
    registerUpdateArtifactRoute('/v1/artifacts/:id/memory-decision', false, true);

    // DELETE /v1/artifacts/:id - Delete artifact
    const registerDeleteArtifactRoute = (url: string, requiresRevision: boolean) => app.delete(url, {
        preHandler: app.authenticate,
        schema: {
            params: z.strictObject({
                id: z.string(),
                expectedHeaderVersion: z.optional(z.coerce.number().check(z.int(), z.nonnegative())),
                expectedBodyVersion: z.optional(z.coerce.number().check(z.int(), z.nonnegative())),
            }).check(z.refine((params) => !requiresRevision
                || (params.expectedHeaderVersion !== undefined && params.expectedBodyVersion !== undefined))),
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

            const deletePayload = buildDeleteArtifactUpdate(id, result.cursor.resolveCursor(), randomKeyNaked(12));
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
