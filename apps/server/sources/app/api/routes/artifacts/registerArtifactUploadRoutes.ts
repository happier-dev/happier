import { Readable } from 'node:stream';
import { rm } from 'node:fs/promises';
import { z } from 'zod/mini';
import { SERVER_HTTP_REQUEST_MAX_BODY_UTF8_BYTES_V1 } from '@happier-dev/protocol/server/http/requestBodyBoundsV1';
import { type ArtifactBlobUploadInitV1 } from '@happier-dev/protocol/artifacts/artifactBinaryV1';
import { ARTIFACT_UPLOAD_CONTENT_TYPE_V1, ARTIFACT_UPLOAD_PATH_V1, decodeArtifactUploadMetadataV1, readBinaryUploadFrameV1, BinaryUploadFrameErrorV1 } from '@happier-dev/transfers';
import { TransferSessionStore, createTransferSessionLifecycle, readFiniteTransferConfig } from '@happier-dev/transfers/node';
import { inReadSnapshot } from '@/storage/inTx';
import { assertPrivateStorageAvailable } from '@/storage/blob/files';
import { resolveArtifactAccessInTx } from '@/app/artifacts/artifactAccessService';
import { resolveEffectiveAccountEncryptionModeFromAccountRow } from '@/app/encryption/accountEncryptionMode';
import { createArtifactHttpMutation, readArtifactPrivateStorageHttpRefusal, updateArtifactHttpMutation } from '@/app/artifacts/artifactMutationHttpResponse';
import { stageArtifactBlobAccountEncryptionConversion, cancelArtifactBlobAccountEncryptionConversion } from '@/app/artifacts/artifactEncryptionConversionBlobService';
import { log } from '@/utils/logging/log';
import { projectActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { Fastify } from '../../types';

type ArtifactUploadHttpResult = Readonly<{ statusCode: number; body: unknown }>;

class UploadRefusal extends Error {
    constructor(readonly response: ArtifactUploadHttpResult) { super('Artifact upload refused'); }
}

async function admitDestination(accountId: string, metadata: ArtifactBlobUploadInitV1): Promise<void> {
    const refusal = await inReadSnapshot(async tx => {
        if (metadata.kind === 'create') {
            const account = await tx.account.findUnique({ where: { id: accountId }, select: { encryptionMode: true } });
            if (!account) return { statusCode: 404, body: { error: 'Artifact not found' } };
            const mode = resolveEffectiveAccountEncryptionModeFromAccountRow(account);
            if (mode.status !== 'ready') return { statusCode: 503, body: { error: 'artifact_content_unavailable' } };
            return (mode.mode === 'plain') === (metadata.t === 'plain') ? null
                : { statusCode: 400, body: { error: 'artifact_account_mode_mismatch' } };
        }
        const access = await resolveArtifactAccessInTx(tx, { actorAccountId: accountId, artifactId: metadata.artifactId });
        if (!access || access.level === 'view' || (metadata.kind === 'encryption-conversion' && access.level !== 'owner')) {
            return { statusCode: 404, body: { error: 'Artifact not found' } };
        }
        if (access.encryptionMode === null) return { statusCode: 503, body: { error: 'artifact_content_unavailable' } };
        const matches = (access.encryptionMode === 'plain') === (metadata.t === 'plain');
        return matches === (metadata.kind !== 'encryption-conversion') ? null
            : { statusCode: 400, body: { error: 'artifact_account_mode_mismatch' } };
    });
    if (refusal) throw new UploadRefusal(refusal);
}

/** The request itself pins the finite receiver to one API replica; no HTTP session routing state. */
export function registerArtifactUploadRoutes(app: Fastify): void {
    app.register(async scoped => {
        const config = readFiniteTransferConfig(process.env);
        const store = new TransferSessionStore({ ttlMs: config.ttlMs });
        const lifecycle = createTransferSessionLifecycle({ store, chunkSizeBytes: config.chunkSizeBytes });
        scoped.addHook('onClose', async () => { await store.dispose(); });
        scoped.addContentTypeParser(ARTIFACT_UPLOAD_CONTENT_TYPE_V1, (_request, payload, done) => done(null, payload));
        scoped.post(ARTIFACT_UPLOAD_PATH_V1, { preHandler: scoped.authenticate }, async (request, reply) => {
            let uploadId: string | null = null;
            let releaseUpload: (() => void) | undefined;
            let stageId: string | null = null;
            let canceled = request.raw.aborted;
            const cancelStage = async () => {
                if (stageId) await cancelArtifactBlobAccountEncryptionConversion({ accountId: request.userId, uploadId: stageId });
            };
            const onAbort = () => { canceled = true; };
            const onResponseClose = () => {
                if (reply.raw.writableFinished) return;
                canceled = true;
                void cancelStage().catch(error => log({ module: 'api', level: 'error' }, `Artifact stage cancellation failed: ${error}`));
            };
            request.raw.once('aborted', onAbort);
            reply.raw.once('close', onResponseClose);
            reply.raw.once('finish', () => reply.raw.off('close', onResponseClose));
            try {
                if (!(request.body instanceof Readable)) throw new UploadRefusal({ statusCode: 415, body: { error: 'artifact_upload_media_type_required' } });
                let index = 0;
                const writeBytes = async (bytes: Uint8Array) => {
                    if (!uploadId || canceled) throw new Error('Artifact upload canceled');
                    for (let offset = 0; offset < bytes.length; offset += config.chunkSizeBytes) {
                        const chunk = await lifecycle.writeUploadTransferChunk({ uploadId, index,
                            contentBytes: bytes.subarray(offset, offset + config.chunkSizeBytes) });
                        if (!chunk.success) throw new Error('Artifact upload chunk refused');
                        index += 1;
                    }
                };
                await readBinaryUploadFrameV1(request.body, {
                    metadataMaxBytes: SERVER_HTTP_REQUEST_MAX_BODY_UTF8_BYTES_V1,
                    decodeMetadata: decodeArtifactUploadMetadataV1,
                    onMetadata: async metadata => {
                        await admitDestination(request.userId, metadata);
                        assertPrivateStorageAvailable();
                        const destination = metadata;
                        const session = await lifecycle.openUploadTransferSession({ target: {
                            destPath: request.userId, destDisplayPath: destination.artifactId,
                            overwrite: destination.kind !== 'create', expectedSizeBytes: destination.sizeBytes,
                            finalizeUpload: async ({ tempPath, sizeBytes, sha256 }) => {
                                try {
                                    if (canceled) throw new Error('Artifact upload canceled');
                                    const content = { t: destination.t, staged: { tempPath, sizeBytes, sha256 } };
                                    let result: ArtifactUploadHttpResult;
                                    if (destination.kind === 'encryption-conversion') {
                                        const stage = await stageArtifactBlobAccountEncryptionConversion({ accountId: request.userId,
                                            artifactId: destination.artifactId, blobId: destination.blobId, content });
                                        stageId = stage.uploadId;
                                        if (canceled) { await cancelStage(); throw new Error('Artifact upload canceled'); }
                                        result = { statusCode: 200, body: stage };
                                    } else {
                                        const blob = { blobId: destination.blobId, content };
                                        result = destination.kind === 'create'
                                            ? await createArtifactHttpMutation(request.userId, { id: destination.artifactId,
                                                kind: destination.artifactKind,
                                                header: destination.header, body: destination.body, dataEncryptionKey: destination.dataEncryptionKey, blob,
                                                provenance: destination.provenance, provenanceDataEncryptionKey: destination.provenanceDataEncryptionKey })
                                            : await updateArtifactHttpMutation(request.userId, destination.artifactId, {
                                                updateOperationId: destination.updateOperationId,
                                                kind: destination.artifactKind,
                                                header: destination.header, expectedHeaderVersion: destination.expectedHeaderVersion,
                                                body: destination.body, expectedBodyVersion: destination.expectedBodyVersion, blob,
                                                provenance: destination.provenance, provenanceDataEncryptionKey: destination.provenanceDataEncryptionKey });
                                    }
                                    return { success: true, path: destination.artifactId, sizeBytes, result };
                                } finally { await rm(tempPath, { force: true }); }
                            },
                        } });
                        uploadId = session.uploadId;
                        // The HTTP request owns this receiver across waits for its next bytes.
                        releaseUpload = store.beginUploadSessionOperation(uploadId)?.release;
                        return [{ storedSizeBytes: metadata.sizeBytes }];
                    },
                    onSegment: async (_index, chunks) => { for await (const bytes of chunks) await writeBytes(bytes); },
                });
                if (!uploadId || canceled) throw new Error('Artifact upload incomplete');
                const finalized = await lifecycle.finalizeUploadTransferSession({ uploadId });
                // Keep the finalize owner's closed code on the rebuilt error for the host record below.
                if (!finalized.success) throw Object.assign(new Error('Artifact upload incomplete'),
                    finalized.errorCode ? { code: finalized.errorCode } : {});
                const result = finalized.finalized.result;
                if (!result || typeof result !== 'object' || !('statusCode' in result) || typeof result.statusCode !== 'number'
                    || !('body' in result)) throw new Error('Artifact upload result unavailable');
                return reply.code(result.statusCode).send(result.body);
            } catch (error) {
                await cancelStage();
                const refusal = error instanceof UploadRefusal ? error.response
                    : readArtifactPrivateStorageHttpRefusal(error) ?? (error instanceof BinaryUploadFrameErrorV1 && error.code === 'metadata_too_large'
                        ? { statusCode: 413, body: { error: 'artifact_upload_metadata_too_large' } }
                        : { statusCode: 400, body: { error: 'artifact_upload_failed' } });
                // One host record of the closed refusal: phase, class and code only, never content, keys or prose.
                const refusalCode = refusal.body && typeof refusal.body === 'object' && 'error' in refusal.body
                    && typeof refusal.body.error === 'string' ? refusal.body.error : undefined;
                log({ module: 'artifact-upload', level: 'warn', statusCode: refusal.statusCode, error: refusalCode,
                    failureCause: projectActionFailureCauseV1(error, 'artifact.upload') });
                return reply.code(refusal.statusCode).send(refusal.body);
            } finally {
                request.raw.off('aborted', onAbort);
                try {
                    if (uploadId) await lifecycle.abortUploadTransferSession({ uploadId });
                } finally { releaseUpload?.(); }
            }
        });
        scoped.delete<{ Params: { uploadId: string } }>('/v1/artifacts/content/uploads/:uploadId', { preHandler: scoped.authenticate,
            schema: { params: z.strictObject({ uploadId: z.string().check(z.uuid()) }) },
        }, async (request, reply) => {
            await cancelArtifactBlobAccountEncryptionConversion({ accountId: request.userId, uploadId: request.params.uploadId });
            return reply.send({ success: true });
        });
    });
}
