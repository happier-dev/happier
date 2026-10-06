import { Readable } from 'node:stream';
import { readFile, rm } from 'node:fs/promises';
import { z } from 'zod';
import { SERVER_HTTP_REQUEST_MAX_BODY_UTF8_BYTES_V1, type ArtifactBlobUploadInitV1 } from '@happier-dev/protocol';
import { ARTIFACT_UPLOAD_CONTENT_TYPE_V1, ARTIFACT_UPLOAD_PATH_V1, decodeArtifactUploadMetadataV1 } from '@happier-dev/transfers';
import { TransferSessionStore, createTransferSessionLifecycle, readFiniteTransferConfig } from '@happier-dev/transfers/node';
import { inTx } from '@/storage/inTx';
import { resolveArtifactAccessInTx } from '@/app/artifacts/artifactAccessService';
import { resolveEffectiveAccountEncryptionModeFromAccountRow } from '@/app/encryption/accountEncryptionMode';
import { createArtifactHttpMutation, updateArtifactHttpMutation } from '@/app/artifacts/artifactMutationHttpResponse';
import { stageArtifactBlobAccountEncryptionConversion, cancelArtifactBlobAccountEncryptionConversion } from '@/app/artifacts/artifactEncryptionConversionBlobService';
import { log } from '@/utils/logging/log';
import type { Fastify } from '../../types';

type ArtifactUploadHttpResult = Readonly<{ statusCode: number; body: unknown }>;

class UploadRefusal extends Error {
    constructor(readonly response: ArtifactUploadHttpResult) { super('Artifact upload refused'); }
}

async function admitDestination(accountId: string, metadata: ArtifactBlobUploadInitV1): Promise<void> {
    const refusal = await inTx(async tx => {
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
        const store = new TransferSessionStore({ ttlMs: config.ttlMs, expiryTrigger: 'self' });
        const lifecycle = createTransferSessionLifecycle({ store, chunkSizeBytes: config.chunkSizeBytes });
        scoped.addHook('onClose', async () => { await store.dispose(); });
        scoped.addContentTypeParser(ARTIFACT_UPLOAD_CONTENT_TYPE_V1, (_request, payload, done) => done(null, payload));
        scoped.post(ARTIFACT_UPLOAD_PATH_V1, { preHandler: scoped.authenticate }, async (request, reply) => {
            let uploadId: string | null = null;
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
                const prefix: Buffer[] = [];
                let prefixBytes = 0;
                let metadata: ArtifactBlobUploadInitV1 | null = null;
                let index = 0;
                const writeBytes = async (bytes: Buffer) => {
                    if (!uploadId || canceled) throw new Error('Artifact upload canceled');
                    for (let offset = 0; offset < bytes.length; offset += config.chunkSizeBytes) {
                        const chunk = await lifecycle.writeUploadTransferChunk({ uploadId, index,
                            contentBase64: bytes.subarray(offset, offset + config.chunkSizeBytes).toString('base64') });
                        if (!chunk.success) throw new Error('Artifact upload chunk refused');
                        index += 1;
                    }
                };
                const stream: AsyncIterable<unknown> = request.body;
                for await (const value of stream) {
                    if (!Buffer.isBuffer(value)) throw new Error('Artifact upload bytes unavailable');
                    let bytes = value;
                    if (!metadata) {
                        const separator = bytes.indexOf(10);
                        const part = separator < 0 ? bytes : bytes.subarray(0, separator);
                        prefixBytes += part.length;
                        // Only metadata inherits the existing API JSON boundary, never the file bytes.
                        if (prefixBytes > SERVER_HTTP_REQUEST_MAX_BODY_UTF8_BYTES_V1) throw new UploadRefusal({
                            statusCode: 413, body: { error: 'artifact_upload_metadata_too_large' },
                        });
                        prefix.push(part);
                        if (separator < 0) continue;
                        metadata = decodeArtifactUploadMetadataV1(Buffer.concat(prefix));
                        prefix.length = 0;
                        await admitDestination(request.userId, metadata);
                        const destination = metadata;
                        const session = await lifecycle.openUploadTransferSession({ target: {
                            destPath: request.userId, destDisplayPath: destination.artifactId,
                            overwrite: destination.kind !== 'create', expectedSizeBytes: destination.sizeBytes,
                            finalizeUpload: async ({ tempPath, sizeBytes }) => {
                                try {
                                    if (canceled) throw new Error('Artifact upload canceled');
                                    const bytes = await readFile(tempPath);
                                    const content = destination.t === 'plain' ? { t: 'plain' as const, v: bytes.toString('base64') }
                                        : { t: 'encrypted' as const, c: bytes.toString('base64') };
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
                                                header: destination.header, body: destination.body, dataEncryptionKey: destination.dataEncryptionKey, blob,
                                                provenance: destination.provenance, provenanceDataEncryptionKey: destination.provenanceDataEncryptionKey })
                                            : await updateArtifactHttpMutation(request.userId, destination.artifactId, {
                                                header: destination.header, expectedHeaderVersion: destination.expectedHeaderVersion,
                                                body: destination.body, expectedBodyVersion: destination.expectedBodyVersion, blob,
                                                provenance: destination.provenance, provenanceDataEncryptionKey: destination.provenanceDataEncryptionKey });
                                    }
                                    return { success: true, path: destination.artifactId, sizeBytes, result };
                                } finally { await rm(tempPath, { force: true }); }
                            },
                        } });
                        uploadId = session.uploadId;
                        bytes = bytes.subarray(separator + 1);
                    }
                    await writeBytes(bytes);
                }
                if (!uploadId || canceled) throw new Error('Artifact upload incomplete');
                const finalized = await lifecycle.finalizeUploadTransferSession({ uploadId });
                if (!finalized.success) throw new Error('Artifact upload incomplete');
                const result = finalized.finalized.result;
                if (!result || typeof result !== 'object' || !('statusCode' in result) || typeof result.statusCode !== 'number'
                    || !('body' in result)) throw new Error('Artifact upload result unavailable');
                return reply.code(result.statusCode).send(result.body);
            } catch (error) {
                await cancelStage();
                const refusal = error instanceof UploadRefusal ? error.response : { statusCode: 400, body: { error: 'artifact_upload_failed' } };
                return reply.code(refusal.statusCode).send(refusal.body);
            } finally {
                request.raw.off('aborted', onAbort);
                if (uploadId) await lifecycle.abortUploadTransferSession({ uploadId });
            }
        });
        scoped.delete<{ Params: { uploadId: string } }>('/v1/artifacts/content/uploads/:uploadId', { preHandler: scoped.authenticate,
            schema: { params: z.object({ uploadId: z.string().uuid() }).strict() },
        }, async (request, reply) => {
            await cancelArtifactBlobAccountEncryptionConversion({ accountId: request.userId, uploadId: request.params.uploadId });
            return reply.send({ success: true });
        });
    });
}
