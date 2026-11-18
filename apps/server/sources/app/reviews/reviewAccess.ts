import { resolveArtifactAccessInTx } from '@/app/artifacts/artifactAccessService';
import type { ResourceGrantAccess } from '@/app/teams/resourceGrantAccess';
import type { Tx } from '@/storage/inTx';

/** One request's admitted Artifact authority for a durable Review. */
export type ReviewAccessCapability = Readonly<ResourceGrantAccess & { reviewId: string }>;

export async function resolveReviewAccessInTx(tx: Tx, input: Readonly<{
    actorAccountId: string; reviewId: string;
}>): Promise<ReviewAccessCapability | null> {
    const access = await resolveArtifactAccessInTx(tx, { actorAccountId: input.actorAccountId, artifactId: input.reviewId });
    if (!access) return null;
    const review = await tx.reviewMetadata.findUnique({ where: { artifactId: input.reviewId }, select: { artifactId: true } });
    return review ? { reviewId: input.reviewId, ownerAccountId: access.ownerAccountId,
        level: access.level, encryptionMode: access.encryptionMode } : null;
}
