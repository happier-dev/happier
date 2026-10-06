import { eventRouter, buildNewArtifactUpdate, buildUpdateArtifactUpdate } from '@/app/events/eventRouter';
import { inTx } from '@/storage/inTx';
import { readArtifactForCallerInTx } from './artifactAccessService';
import { createArtifact, updateArtifact } from './artifactWriteService';
import { randomKeyNaked } from '@/utils/keys/randomKeyNaked';
import { log } from '@/utils/logging/log';
import * as privacyKit from 'privacy-kit';
import type { ArtifactBlobWriteV1 } from '@happier-dev/protocol';

export type ArtifactHttpMutationResult = Awaited<ReturnType<typeof createArtifactHttpMutation | typeof updateArtifactHttpMutation>>;
export type ArtifactCreateHttpInput = Readonly<{ id: string; header: string; body: string; dataEncryptionKey: string; provenance?: string | null; provenanceDataEncryptionKey?: string | null; blob?: ArtifactBlobWriteV1 }>;
export type ArtifactUpdateHttpInput = Readonly<{ header?: string; expectedHeaderVersion?: number; body?: string; expectedBodyVersion?: number; provenance?: string | null; provenanceDataEncryptionKey?: string | null; blob?: ArtifactBlobWriteV1 | null }>;

export async function createArtifactHttpMutation(userId: string, input: ArtifactCreateHttpInput) {
        const { id, header, body, dataEncryptionKey, blob } = input;

        try {
            log({ module: 'api', artifactId: id, userId }, 'Creating artifact');
            const result = await createArtifact({
                actorUserId: userId,
                artifactId: id,
                header: privacyKit.decodeBase64(header),
                body: privacyKit.decodeBase64(body),
                dataEncryptionKey: privacyKit.decodeBase64(dataEncryptionKey),
                provenance: input.provenance == null ? undefined : privacyKit.decodeBase64(input.provenance),
                provenanceDataEncryptionKey: input.provenanceDataEncryptionKey == null ? undefined : privacyKit.decodeBase64(input.provenanceDataEncryptionKey),
                blob,
            });

            if (!result.ok) {
                if (result.error === 'quota_exceeded') return { statusCode: 413 as const, body: { error: result.error, budget: result.budget, limitBytes: result.limitBytes, usedBytes: result.usedBytes } };
                if (result.error === 'invalid-params') {
                    return { statusCode: 400 as const, body: { error: 'Invalid parameters' as const } };
                }
                if (result.error === 'conflict') {
                    return { statusCode: 409 as const, body: {
                        error: 'Artifact with this ID already exists for another account' as const
                    } };
                }

                return { statusCode: 500 as const, body: { error: 'Failed to create artifact' as const } };
            }

            if (result.didWrite) {
                const newArtifactPayload = buildNewArtifactUpdate(result.artifact, result.cursor, randomKeyNaked(12));
                eventRouter.emitUpdate({
                    userId,
                    payload: newArtifactPayload,
                    recipientFilter: { type: 'user-scoped-only' }
                });
            } else {
                log({ module: 'api', artifactId: id, userId }, 'Found existing artifact');
            }

            const read = await inTx(tx => readArtifactForCallerInTx(tx, { actorAccountId: userId, artifactId: id }));
            if (!read.ok) return { statusCode: 500 as const, body: { error: 'Failed to create artifact' as const } };
            const artifact = read.artifact;
            return { statusCode: 200 as const, body: {
                id: artifact.id,
                ownerAccountId: artifact.ownerAccountId,
                access: artifact.access,
                encryptionMode: artifact.encryptionMode,
                header: privacyKit.encodeBase64(artifact.header),
                headerVersion: artifact.headerVersion,
                body: privacyKit.encodeBase64(artifact.body),
                bodyVersion: artifact.bodyVersion,
                dataEncryptionKey: privacyKit.encodeBase64(artifact.dataEncryptionKey),
                provenance: artifact.provenance ? privacyKit.encodeBase64(artifact.provenance) : null,
                provenanceDataEncryptionKey: artifact.provenanceDataEncryptionKey ? privacyKit.encodeBase64(artifact.provenanceDataEncryptionKey) : null,
                seq: artifact.seq,
                createdAt: artifact.createdAt.getTime(),
                updatedAt: artifact.updatedAt.getTime()
            } };
        } catch (error) {
            log({ module: 'api', level: 'error' }, `Failed to create artifact: ${error}`);
            return { statusCode: 500 as const, body: { error: 'Failed to create artifact' as const } };
        }
    }

export async function updateArtifactHttpMutation(userId: string, artifactId: string, input: ArtifactUpdateHttpInput) {
        const id = artifactId;
        const { header, expectedHeaderVersion, body, expectedBodyVersion, blob } = input;

        try {
            if (header !== undefined && expectedHeaderVersion === undefined) {
                return { statusCode: 400 as const, body: { error: 'Invalid parameters' as const } };
            }
            if (body !== undefined && expectedBodyVersion === undefined) {
                return { statusCode: 400 as const, body: { error: 'Invalid parameters' as const } };
            }

            const headerParam = header !== undefined && expectedHeaderVersion !== undefined
                ? { bytes: privacyKit.decodeBase64(header), expectedVersion: expectedHeaderVersion }
                : undefined;
            const bodyParam = body !== undefined && expectedBodyVersion !== undefined
                ? { bytes: privacyKit.decodeBase64(body), expectedVersion: expectedBodyVersion }
                : undefined;

            if (!headerParam && !bodyParam) {
                return { statusCode: 400 as const, body: { error: 'Invalid parameters' as const } };
            }

            const result = await updateArtifact({
                actorUserId: userId,
                artifactId: id,
                header: headerParam,
                body: bodyParam,
                provenance: input.provenance == null ? undefined : privacyKit.decodeBase64(input.provenance),
                provenanceDataEncryptionKey: input.provenanceDataEncryptionKey == null ? undefined : privacyKit.decodeBase64(input.provenanceDataEncryptionKey),
                blob,
            });

            if (!result.ok) {
                if (result.error === 'artifact_binary_content_requires_explicit_update') {
                    return { statusCode: 409 as const, body: { error: result.error } };
                }
                if (result.error === 'quota_exceeded') return { statusCode: 413 as const, body: { error: result.error, budget: result.budget, limitBytes: result.limitBytes, usedBytes: result.usedBytes } };
                if (result.error === 'invalid-params') {
                    return { statusCode: 400 as const, body: { error: 'Invalid parameters' as const } };
                }
                if (result.error === 'not-found') {
                    return { statusCode: 404 as const, body: { error: 'Artifact not found' as const } };
                }

                if (result.error === 'version-mismatch') {
                    return { statusCode: 200 as const, body: {
                        success: false as const,
                        error: 'version-mismatch' as const,
                        ...(headerParam && result.current && {
                            currentHeaderVersion: result.current.headerVersion,
                            currentHeader: Buffer.from(result.current.header).toString('base64'),
                        }),
                        ...(bodyParam && result.current && {
                            currentBodyVersion: result.current.bodyVersion,
                            currentBody: Buffer.from(result.current.body).toString('base64'),
                        }),
                    } };
                }
                return { statusCode: 500 as const, body: { error: 'Failed to update artifact' as const } };
            }

            const headerUpdate = headerParam && result.header
                ? { value: header!, version: result.header.version }
                : undefined;
            const bodyUpdate = bodyParam && result.body
                ? { value: body!, version: result.body.version }
                : undefined;

            for (const recipient of result.recipientUpdates) {
                eventRouter.emitUpdate({
                    userId: recipient.accountId,
                    payload: buildUpdateArtifactUpdate(id, recipient.cursor, randomKeyNaked(12), headerUpdate, bodyUpdate, recipient),
                    recipientFilter: { type: 'user-scoped-only' }
                });
            }

            return { statusCode: 200 as const, body: {
                success: true as const,
                ...(headerUpdate && { headerVersion: headerUpdate.version }),
                ...(bodyUpdate && { bodyVersion: bodyUpdate.version }),
            } };
        } catch (error) {
            log({ module: 'api', level: 'error' }, `Failed to update artifact: ${error}`);
            return { statusCode: 500 as const, body: { error: 'Failed to update artifact' as const } };
        }
    }
