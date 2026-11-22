import type { ReviewMetadataWriteV1, ReviewRoundBindingV1 } from '@happier-dev/protocol/reviews/reviewArtifactV1';
import type { Tx } from '@/storage/inTx';
import { inReadSnapshot } from '@/storage/inTx';
import { PrincipalRefV1Schema } from '@happier-dev/protocol/teams/principal';
import { admitReviewRequestedReviewersInTx } from './reviewReviewerAdmission';
import { buildSessionAccessWhere } from '@/app/session/access/sessionAccessWhere';
import type { SessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication';

function notAdmitted(): never {
    throw Object.assign(new Error('invalid-params'), { code: 'invalid-params' });
}

/** Admission only. The admitted materializer carries this binding through its later writes. */
export async function assertReviewRoundBindingInTx(tx: Tx, binding: ReviewRoundBindingV1): Promise<void> {
    const current = await tx.reviewMetadata.findUnique({ where: { artifactId: binding.reviewId }, select: { currentRoundOrdinal: true } });
    if (current?.currentRoundOrdinal !== binding.roundOrdinal) notAdmitted();
}
export async function assertReviewRoundBinding(binding: ReviewRoundBindingV1): Promise<void> {
    await inReadSnapshot(tx => assertReviewRoundBindingInTx(tx, binding));
}

/** A round covers its source Session up to that Session's seq at round start. The writer must be able to read it. */
async function readSourceSessionPosition(tx: Tx, input: Readonly<{ metadata: Extract<ReviewMetadataWriteV1, { state: 'running' }>;
    actorAccountId: string; authentication?: SessionAccessAuthentication }>) {
    const sessionId = input.metadata.sourceSessionId;
    if (!sessionId) return { sourceSessionId: null, sourceSessionSeq: null };
    const access = await buildSessionAccessWhere({ mode: 'effective_access_v1', tx, accountId: input.actorAccountId, capability: 'readTranscript',
        authentication: input.authentication ?? { env: process.env, authority: 'account_automation', authenticationEvidence: undefined } });
    const session = await tx.session.findFirst({ where: { AND: [{ id: sessionId }, access] }, select: { seq: true } });
    if (!session) notAdmitted();
    return { sourceSessionId: sessionId, sourceSessionSeq: session.seq };
}

/** The existing Artifact mutation calls this once inside its content/publication transaction.
 * Later rounds advance lifecycle state and the covered Session position while retaining the Review's original source identity.
 */
export async function writeReviewRoundState(tx: Tx, input: Readonly<{ reviewId: string; metadata: ReviewMetadataWriteV1;
    actorAccountId: string; authentication?: SessionAccessAuthentication }>): Promise<boolean> {
    const { reviewId, metadata } = input;
    const current = await tx.reviewMetadata.findUnique({ where: { artifactId: reviewId } });
    if (metadata.state === 'running') {
        if (current?.currentRoundOrdinal === metadata.currentRoundOrdinal) return false;
        if (metadata.currentRoundOrdinal !== (current?.currentRoundOrdinal ?? 0) + 1) notAdmitted();
        const data = { state: metadata.state, currentRoundOrdinal: metadata.currentRoundOrdinal,
            startedAt: new Date(metadata.startedAt), finishedAt: null, ...await readSourceSessionPosition(tx, input) };
        if (current) {
            await tx.reviewMetadata.update({ where: { artifactId: reviewId }, data });
            // Re-admit the requested roster, preserving required/optional flags.
            // Eligibility stays frozen within each round, not across rounds.
            const requests = await tx.reviewRequestedReviewer.findMany({
                where: { reviewId, roundOrdinal: current.currentRoundOrdinal },
                select: { principal: true, required: true },
            });
            await admitReviewRequestedReviewersInTx(tx, { reviewId, roundOrdinal: metadata.currentRoundOrdinal,
                reviewers: requests.map(request => ({ principal: PrincipalRefV1Schema.parse(request.principal), required: request.required })) });
        }
        else await tx.reviewMetadata.create({ data: { artifactId: reviewId, projectSourceId: metadata.projectSourceId,
            workflowId: metadata.workflowId, workflowRunId: metadata.workflowRunId ?? null,
            subjectKind: metadata.subjectKind, sourceKind: metadata.sourceKind, ...data } });
        return true;
    }
    if (current?.currentRoundOrdinal !== metadata.currentRoundOrdinal) notAdmitted();
    if (current.state !== 'running') {
        if (current.state === metadata.state && current.finishedAt?.getTime() === metadata.finishedAt) return false;
        notAdmitted();
    }
    await tx.reviewMetadata.update({ where: { artifactId: reviewId }, data: { state: metadata.state, finishedAt: new Date(metadata.finishedAt) } });
    return true;
}
