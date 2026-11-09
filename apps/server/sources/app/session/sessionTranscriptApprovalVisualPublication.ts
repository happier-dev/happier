import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod/mini';
import { ApprovalTranscriptVisualPublicationV1Schema, type ApprovalTranscriptVisualPublicationV1 } from '@happier-dev/protocol/sessions/messages/transcriptObservationV1';
import { SessionTranscriptSurfaceItemReferencesV1Schema } from '@happier-dev/protocol/sessions/messages/transcriptObservationV1';
import { decodeArtifactKindV1 } from '@happier-dev/protocol/artifacts/artifactKindV1';
import { acquireArtifactPublicationLocksInTx } from '@/app/artifacts/artifactAccessService';
import { inTx, type Tx } from '@/storage/inTx';
import { acquireSessionAccountCursorLocksInTx } from './changeTracking/acquireSessionAccountCursorLocksInTx';
import { markSessionProjectionRecipientsChanged } from './changeTracking/markSessionProjectionRecipientsChanged';
import { admitSessionTranscriptSurfaceItemReferenceInTx, enrichSessionTranscriptSurfaceItemReferencesInTx } from './sessionTranscriptWrite';
import { normalizeSessionMessageContentForStorage } from './normalizeSessionMessageContentForStorage';

const StoredPublication = z.strictObject({ v: z.literal(1), sessionId: z.string(),
    native: z.optional(z.strictObject({ localId: z.string(), messageId: z.string() })),
    surfaceItemReference: z.optional(SessionTranscriptSurfaceItemReferencesV1Schema),
});

export class InvalidApprovalTranscriptVisualPublicationError extends Error {}

/** Both event orders meet at the Artifact's existing transaction lock; only the transcript writer admits Item grants. */
async function retainAndEnrichInTx(tx: Tx, params: Readonly<{
    accountId: string; artifactId: string; sessionId: string;
    native?: Readonly<{ localId: string; messageId: string; content: PrismaJson.SessionMessageContent }>;
    publication?: ApprovalTranscriptVisualPublicationV1;
}>): Promise<boolean> {
    const artifact = await tx.artifact.findUnique({ where: { id: params.artifactId },
        select: { accountId: true, approvalSessionId: true, kind: true, deletedAt: true,
            transcriptVisualPublication: true, updatedAt: true } });
    if (!artifact || artifact.accountId !== params.accountId || artifact.deletedAt !== null
        || artifact.approvalSessionId !== params.sessionId
        || decodeArtifactKindV1(artifact.kind).kindHint !== 'approval_request.v1') return false;
    const parsed = StoredPublication.safeParse(artifact.transcriptVisualPublication);
    const previous = parsed.success ? parsed.data : null;
    if (previous && previous.sessionId !== params.sessionId) return false;
    const candidate = params.publication?.surfaceItemReference ?? previous?.surfaceItemReference;
    if (candidate?.references.some(reference => !('approvalRequestArtifactId' in reference)
        || reference.approvalRequestArtifactId !== params.artifactId
        || reference.sourceAddress.sessionId !== params.sessionId
        || !('sourceItemId' in reference) || reference.sourceItemId !== reference.itemId
        || reference.sourceItemRevision !== reference.itemRevision)) return false;
    await acquireSessionAccountCursorLocksInTx(tx, [params.sessionId]);
    const session = await tx.session.findUnique({ where: { id: params.sessionId }, select: { accountId: true, encryptionMode: true } });
    if (!session) return true;
    if (session.accountId !== params.accountId) return false;
    const native = params.native ?? previous?.native;
    if (params.native && previous?.native && !isDeepStrictEqual(previous.native,
        { localId: params.native.localId, messageId: params.native.messageId })) return false;
    const stored = native ? await tx.sessionMessage.findUnique({ where: { id: native.messageId },
        select: { id: true, sessionId: true, localId: true, messageRole: true, content: true, rowRevision: true, surfaceItemReference: true } }) : null;
    if (native && !stored) return params.native === undefined;
    // Native tool results are event rows; older admitted agent rows keep their correspondence.
    if (native && stored && (stored.sessionId !== params.sessionId || stored.localId !== native.localId
        || (stored.messageRole !== 'agent' && stored.messageRole !== 'event'))) return false;
    if (params.native && !isDeepStrictEqual(stored?.content, normalizeSessionMessageContentForStorage(params.native.content))) return false;
    const mode = session.encryptionMode === 'plain' ? 'plain' : 'e2ee';
    const admitted = candidate ? await admitSessionTranscriptSurfaceItemReferenceInTx(tx, {
        accountId: params.accountId, sessionId: params.sessionId, sessionEncryptionMode: mode, surfaceItemReference: candidate,
    }) : undefined;
    // The effect's outcome is authoritative even if its derived visual disappeared
    // before settlement. An unavailable Item cannot grant a read or veto the body CAS.
    if (candidate && !isDeepStrictEqual(candidate, admitted)) return true;
    const next = { v: 1 as const, sessionId: params.sessionId,
        ...(native ? { native: { localId: native.localId, messageId: native.messageId } } : {}),
        ...(admitted ? { surfaceItemReference: admitted } : {}),
    };
    const enriched = stored && admitted ? await enrichSessionTranscriptSurfaceItemReferencesInTx(tx, {
        sessionId: params.sessionId, sessionEncryptionMode: mode, stored, surfaceItemReference: admitted,
    }) : null;
    if (enriched) await markSessionProjectionRecipientsChanged({ tx, sessionId: params.sessionId,
        hint: { updatedMessageId: enriched.id, updatedMessageSeq: enriched.seq,
            updatedMessageUpdatedAt: enriched.updatedAt.getTime() } });
    if (!isDeepStrictEqual(artifact.transcriptVisualPublication, next)) await tx.artifact.update({
        where: { id: params.artifactId }, data: { transcriptVisualPublication: next, updatedAt: artifact.updatedAt },
    });
    return true;
}

/** Completes the already-admitted native write before its durable transport ACK. */
export async function bindSessionTranscriptApprovalVisualPublication(params: Readonly<{
    accountId: string; artifactId: string; sessionId: string; localId: string; messageId: string; content: PrismaJson.SessionMessageContent;
}>): Promise<boolean> {
    return await inTx(async tx => {
        await acquireArtifactPublicationLocksInTx(tx, params.artifactId);
        return await retainAndEnrichInTx(tx, { ...params,
            native: { localId: params.localId, messageId: params.messageId, content: params.content } });
    });
}

/** The existing Artifact body CAS has already committed this validated settlement in this transaction. */
export async function settleSessionTranscriptApprovalVisualPublicationInTx(tx: Tx, params: Readonly<{
    accountId: string; artifactId: string; publication: ApprovalTranscriptVisualPublicationV1;
}>): Promise<void> {
    const publication = ApprovalTranscriptVisualPublicationV1Schema.safeParse(params.publication);
    if (!publication.success) throw new InvalidApprovalTranscriptVisualPublicationError();
    if (!await retainAndEnrichInTx(tx, { ...params, sessionId: publication.data.sessionId })) {
        throw new InvalidApprovalTranscriptVisualPublicationError();
    }
}
