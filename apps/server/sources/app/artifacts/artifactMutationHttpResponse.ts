import type { ReviewMetadataWriteV1 } from '@happier-dev/protocol/reviews/reviewArtifactV1';
import { createHash } from 'node:crypto';
import { projectNativeJsonValueForTransport } from '@happier-dev/protocol/json/strictJsonValue';
import { createCanonicalJsonSigningInput } from '@happier-dev/protocol/crypto/canonicalJson';
import { projectArtifactHttpRead } from './artifactHttpRead';
import { eventRouter, buildNewArtifactUpdate, buildUpdateArtifactUpdate } from '@/app/events/eventRouter';
import { inReadSnapshot } from '@/storage/inTx';
import { readArtifactForCallerInTx, type ArtifactMutationTransactionGuard } from './artifactAccessService';
import { createArtifact, updateArtifact } from './artifactWriteService';
import { randomKeyNaked } from '@/utils/keys/randomKeyNaked';
import { log } from '@/utils/logging/log';
import * as privacyKit from 'privacy-kit';
import type { ArtifactBlobWriteV1 } from '@happier-dev/protocol/artifacts/artifactBinaryV1';
import type { CoordinationMessageRefV1 } from '@happier-dev/protocol/discussions/messageRefs';
import type { SessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication';
import { readDatabaseErrorCode } from '@/storage/transactionErrors';
import { PrivateStorageUnavailableError } from '@/storage/blob/files';
import type { ApprovalArtifactQueryHintsV1 } from '@happier-dev/protocol/approvals/approvalArtifactKindV1';
import type { ApprovalInputCustody } from '@happier-dev/protocol/approvals/approvalInputCustody';
import type { ArtifactIdScopeV1 } from '@happier-dev/protocol';
import type { ApprovalTranscriptVisualPublicationV1 } from '@happier-dev/protocol/sessions/messages/transcriptObservationV1';

export type ArtifactHttpMutationResult = Awaited<ReturnType<typeof createArtifactHttpMutation | typeof updateArtifactHttpMutation>>;
export type ArtifactCreateHttpInput = Readonly<{ id: string; idScope?: ArtifactIdScopeV1; kind?: string; reviewMetadata?: ReviewMetadataWriteV1; header: string; body: string; dataEncryptionKey: string; provenance?: string | null; provenanceDataEncryptionKey?: string | null; blob?: ArtifactBlobWriteV1; memoryDecisionSource?: CoordinationMessageRefV1 } & Partial<ApprovalArtifactQueryHintsV1>>;
export type ArtifactUpdateHttpInput = Readonly<{ updateOperationId?: string; transcriptVisualPublication?: ApprovalTranscriptVisualPublicationV1; approvalInputCustody?: ApprovalInputCustody; kind?: string; reviewMetadata?: ReviewMetadataWriteV1; header?: string; expectedHeaderVersion?: number; body?: string; expectedBodyVersion?: number; provenance?: string | null; provenanceDataEncryptionKey?: string | null; blob?: ArtifactBlobWriteV1 | null; memoryDecisionSource?: CoordinationMessageRefV1 } & Partial<ApprovalArtifactQueryHintsV1>>;

export function readArtifactPrivateStorageHttpRefusal(error: unknown) {
    return error instanceof PrivateStorageUnavailableError
        ? { statusCode: 503 as const, body: { error: error.code, reason: error.reason } }
        : null;
}

function memoryDecisionHttpFailure(error: string) {
    if (error === 'memory_decision_source_unavailable') return { statusCode: 404 as const, body: { error: 'memory_decision_source_unavailable' as const } };
    if (error === 'memory_decision_source_unsupported') return { statusCode: 409 as const, body: { error: 'memory_decision_source_unsupported' as const } };
    if (error === 'memory_decision_disclosure_denied') return { statusCode: 403 as const, body: { error: 'memory_decision_disclosure_denied' as const } };
    return null;
}

export async function createArtifactHttpMutation(userId: string, input: ArtifactCreateHttpInput, authentication?: SessionAccessAuthentication,
    mutationGuard?: ArtifactMutationTransactionGuard,
    /** The request's verified credential kind (never request input). */
    writerAuthTokenKind?: unknown,
) {
        const { id, header, body, dataEncryptionKey, blob } = input;
        let createSucceeded = false;

        try {
            log({ module: 'api', artifactId: id, userId }, 'Creating artifact');
            const result = await createArtifact({
                actorUserId: userId,
                artifactId: id,
                mutationGuard,
                ...(input.idScope === undefined ? {} : { idScope: input.idScope }),
                kind: input.kind,
                reviewMetadata: input.reviewMetadata,
                approvalState: input.approvalState, approvalSessionId: input.approvalSessionId,
                header: privacyKit.decodeBase64(header),
                body: privacyKit.decodeBase64(body),
                dataEncryptionKey: privacyKit.decodeBase64(dataEncryptionKey),
                provenance: input.provenance == null ? undefined : privacyKit.decodeBase64(input.provenance),
                provenanceDataEncryptionKey: input.provenanceDataEncryptionKey == null ? undefined : privacyKit.decodeBase64(input.provenanceDataEncryptionKey),
                blob,
                memoryDecisionSource: input.memoryDecisionSource, authentication, writerAuthTokenKind,
            });

            if (!result.ok) {
                if (result.error === 'artifact_access_forbidden') return { statusCode: 403 as const, body: { error: result.error } };
                const decisionFailure = memoryDecisionHttpFailure(result.error);
                if (decisionFailure) return decisionFailure;
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
            createSucceeded = true;

            if (result.didWrite && result.legacySocketPublication) {
                const newArtifactPayload = buildNewArtifactUpdate(result.artifact, result.cursor.resolveCursor(), randomKeyNaked(12));
                eventRouter.emitUpdate({
                    userId,
                    payload: newArtifactPayload,
                    recipientFilter: { type: 'user-scoped-only' }
                });
            } else {
                log({ module: 'api', artifactId: id, userId }, 'Found existing artifact');
            }

            const read = await inReadSnapshot(tx => readArtifactForCallerInTx(tx, { actorAccountId: userId, artifactId: id }), {
                transactionClass: 'artifact-create-response-read',
            });
            if (!read.ok) return { statusCode: 500 as const, body: { error: 'Failed to create artifact' as const } };
            return { statusCode: 200 as const, body: { ...projectArtifactHttpRead(read.artifact), created: result.didWrite } };
        } catch (error) {
            const storageRefusal = readArtifactPrivateStorageHttpRefusal(error);
            if (storageRefusal) return storageRefusal;
            const databaseError = readDatabaseErrorCode(error);
            // A failed response read cannot certify rollback of the preceding
            // committed create. Keep that acknowledgement failure uncertain.
            if (databaseError && !createSucceeded) return { statusCode: 503 as const, body: { error: databaseError, statusCode: 503 as const } };
            log({ module: 'api', level: 'error' }, `Failed to create artifact: ${error}`);
            return { statusCode: 500 as const, body: { error: 'Failed to create artifact' as const } };
        }
    }

export async function updateArtifactHttpMutation(userId: string, artifactId: string, input: ArtifactUpdateHttpInput, authentication?: SessionAccessAuthentication,
    mutationGuard?: ArtifactMutationTransactionGuard,
    /** The request's verified credential kind (never request input). */
    writerAuthTokenKind?: unknown,
) {
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

            if (!headerParam && !bodyParam && ((input.kind === undefined && input.approvalState === undefined && input.approvalSessionId === undefined) || expectedHeaderVersion === undefined)) {
                return { statusCode: 400 as const, body: { error: 'Invalid parameters' as const } };
            }

            // The nonce distinguishes independent claims even when their content is identical.
            // Bind it to the entire admitted request; uploaded bytes already belong to blobId.
            const updateOperationKey = input.updateOperationId ? createHash('sha256').update(
                createCanonicalJsonSigningInput(projectNativeJsonValueForTransport({ ...input, blob: input.blob ? { blobId: input.blob.blobId } : input.blob })),
            ).digest('hex') : undefined;
            const result = await updateArtifact({
                updateOperationKey,
                transcriptVisualPublication: input.transcriptVisualPublication,
                approvalInputCustody: input.approvalInputCustody,
                actorUserId: userId,
                artifactId: id,
                mutationGuard,
                kind: input.kind,
                reviewMetadata: input.reviewMetadata,
                approvalState: input.approvalState, approvalSessionId: input.approvalSessionId,
                expectedHeaderVersion,
                header: headerParam,
                body: bodyParam,
                provenance: input.provenance == null ? undefined : privacyKit.decodeBase64(input.provenance),
                provenanceDataEncryptionKey: input.provenanceDataEncryptionKey == null ? undefined : privacyKit.decodeBase64(input.provenanceDataEncryptionKey),
                blob,
                memoryDecisionSource: input.memoryDecisionSource, authentication, writerAuthTokenKind,
            });

            if (!result.ok) {
                if (result.error === 'artifact_access_forbidden') return { statusCode: 403 as const, body: { error: result.error } };
                const decisionFailure = memoryDecisionHttpFailure(result.error);
                if (decisionFailure) return decisionFailure;
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
                        ...((headerParam || input.kind !== undefined) && result.current && {
                            currentHeaderVersion: result.current.headerVersion,
                            currentHeader: Buffer.from(result.current.header).toString('base64'),
                        }),
                        ...(bodyParam && result.current?.body !== undefined && {
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

            for (const recipient of result.legacySocketPublication ? result.recipientUpdates : []) {
                eventRouter.emitUpdate({
                    userId: recipient.accountId,
                    payload: buildUpdateArtifactUpdate(id, recipient.cursor.resolveCursor(), randomKeyNaked(12), headerUpdate, bodyUpdate, recipient),
                    recipientFilter: { type: 'user-scoped-only' }
                });
            }

            return { statusCode: 200 as const, body: {
                success: true as const,
                ...(headerUpdate && { headerVersion: headerUpdate.version }),
                ...(bodyUpdate && { bodyVersion: bodyUpdate.version }),
            } };
        } catch (error) {
            const storageRefusal = readArtifactPrivateStorageHttpRefusal(error);
            if (storageRefusal) return storageRefusal;
            const databaseError = readDatabaseErrorCode(error);
            if (databaseError) return { statusCode: 503 as const, body: { error: databaseError, statusCode: 503 as const } };
            log({ module: 'api', level: 'error' }, `Failed to update artifact: ${error}`);
            return { statusCode: 500 as const, body: { error: 'Failed to update artifact' as const } };
        }
    }
