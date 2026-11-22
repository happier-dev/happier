import type { ReviewMetadata } from '@prisma/client';
import { resolveArtifactAccessInTx, resolveArtifactAccessWithTimestampsInTx } from '@/app/artifacts/artifactAccessService';
import type { ResourceGrantAccess } from '@/app/teams/resourceGrantAccess';
import type { Tx } from '@/storage/inTx';

/** One request's admitted Artifact authority for a durable Review. */
export type ReviewAccessCapability = Readonly<ResourceGrantAccess & { reviewId: string }>;

/** Admitted Review display facts for the current read snapshot. */
export type ReviewDetailAdmission = ReviewAccessCapability & Readonly<{
    detail: Readonly<{ metadata: ReviewMetadata; createdAt: Date; updatedAt: Date }>;
}>;

type ReviewAccessInput = Readonly<{ actorAccountId: string; reviewId: string }>;

export function resolveReviewAccessInTx(tx: Tx, input: ReviewAccessInput & { includeDetail: true }): Promise<ReviewDetailAdmission | null>;
export function resolveReviewAccessInTx(tx: Tx, input: ReviewAccessInput): Promise<ReviewAccessCapability | null>;
export async function resolveReviewAccessInTx(tx: Tx, input: ReviewAccessInput & { includeDetail?: true }): Promise<ReviewAccessCapability | ReviewDetailAdmission | null> {
    const artifactInput = { actorAccountId: input.actorAccountId, artifactId: input.reviewId };
    const artifact = input.includeDetail ? await resolveArtifactAccessWithTimestampsInTx(tx, artifactInput) : null;
    const access = input.includeDetail ? artifact?.access : await resolveArtifactAccessInTx(tx, artifactInput);
    if (!access) return null;
    const capability = { reviewId: input.reviewId, ownerAccountId: access.ownerAccountId,
        level: access.level, encryptionMode: access.encryptionMode };
    const where = { artifactId: input.reviewId };
    if (artifact) {
        const metadata = await tx.reviewMetadata.findUnique({ where });
        return metadata ? { ...capability, detail: { metadata, createdAt: artifact.createdAt, updatedAt: artifact.updatedAt } } : null;
    }
    return await tx.reviewMetadata.findUnique({ where, select: { artifactId: true } }) ? capability : null;
}
