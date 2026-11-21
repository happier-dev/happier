import { ArtifactReviewGraphAccountEncryptionMigrationV1Schema, type ArtifactReviewGraphAccountEncryptionMigrationV1 } from '@happier-dev/protocol/artifacts/artifactAccountEncryptionMigrationV1';
import { openReviewCommentSensitiveEnvelopeV1, openReviewCommentEventSensitiveEnvelopeV1 } from '@happier-dev/protocol/reviews/comments/content';
import { openReviewVerdictContentV1 } from '@happier-dev/protocol/reviews/reviewHumanV1';
import type { StoredJsonContentEnvelope } from '@happier-dev/protocol/storage/storedJsonContentEnvelope';
import type { ArtifactEncryption } from '@/sync/encryption/artifactEncryption';

/** Reuses the source and replacement Artifact keys; author Accounts are attribution. */
export async function buildArtifactReviewGraphAccountEncryptionMigration(params: Readonly<{
    reviewId: string;
    graph: ArtifactReviewGraphAccountEncryptionMigrationV1;
    fromMode: 'plain' | 'e2ee';
    toMode: 'plain' | 'e2ee';
    sourceEncryption: ArtifactEncryption | null;
    targetEncryption: ArtifactEncryption | null;
}>): Promise<ArtifactReviewGraphAccountEncryptionMigrationV1> {
    const graph = ArtifactReviewGraphAccountEncryptionMigrationV1Schema.parse(params.graph);
    const open = async (envelope: StoredJsonContentEnvelope): Promise<Record<string, unknown>> => {
        if (envelope.t !== (params.fromMode === 'plain' ? 'plain' : 'encrypted')) throw new Error('review_comment_encryption_mode_mismatch');
        const value = envelope.t === 'plain' ? envelope.v : await params.sourceEncryption?.decryptHeaderRaw(envelope.c);
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('review_comment_migration_source_locked');
        return value as Record<string, unknown>;
    };
    const seal = async (value: Record<string, unknown>): Promise<StoredJsonContentEnvelope> => {
        if (params.toMode === 'plain') return { t: 'plain', v: value };
        if (!params.targetEncryption) throw new Error('review_comment_migration_target_material_unavailable');
        return { t: 'encrypted', c: await params.targetEncryption.encryptHeader(value) };
    };
    const comments: ArtifactReviewGraphAccountEncryptionMigrationV1['comments'] = [];
    for (const item of graph.comments) {
        if (item.stored.structural.reviewId !== params.reviewId) throw new Error('review_comment_migration_inventory_mismatch');
        const value = await open(item.stored.sensitiveEnvelope);
        if (openReviewCommentSensitiveEnvelopeV1({ structural: item.stored.structural, envelope: { t: 'plain', v: value }, mode: 'plain' }).status !== 'available') {
            throw new Error('review_comment_migration_comment_binding_mismatch');
        }
        const events: typeof item.events = [];
        for (const event of item.events) {
            if (event.event.reviewId !== params.reviewId || event.event.commentId !== item.stored.structural.id) throw new Error('review_comment_migration_event_binding_mismatch');
            const payload = await open(event.sensitiveEnvelope.sensitive);
            const bound = { ...event.sensitiveEnvelope, sensitive: { t: 'plain' as const, v: payload } };
            if (openReviewCommentEventSensitiveEnvelopeV1({ event: event.event, bound, mode: 'plain' }).status !== 'available') {
                throw new Error('review_comment_migration_event_binding_mismatch');
            }
            events.push({ event: event.event, sensitiveEnvelope: { ...event.sensitiveEnvelope, sensitive: await seal(payload) } });
        }
        comments.push({ stored: { ...item.stored, sensitiveEnvelope: await seal(value) }, events });
    }
    const verdicts: ArtifactReviewGraphAccountEncryptionMigrationV1['verdicts'] = [];
    for (const item of graph.verdicts) {
        if (item.reviewId !== params.reviewId) throw new Error('review_comment_migration_inventory_mismatch');
        const value = item.content ? await openReviewVerdictContentV1({ content: item.content, expected: item, open }) : null;
        verdicts.push({ ...item, content: value ? await seal(value) : null });
    }
    return { comments, verdicts };
}
