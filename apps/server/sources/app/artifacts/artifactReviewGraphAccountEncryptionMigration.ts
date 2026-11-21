import { isDeepStrictEqual } from 'node:util';
import type { Prisma as PrismaTypes } from '@prisma/client';
import { ArtifactReviewGraphAccountEncryptionMigrationV1Schema, type ArtifactReviewGraphAccountEncryptionMigrationV1 } from '@happier-dev/protocol/artifacts/artifactAccountEncryptionMigrationV1';
import { BoundReviewCommentEventSensitiveEnvelopeV1Schema, openReviewCommentSensitiveEnvelopeV1, openReviewCommentEventSensitiveEnvelopeV1 } from '@happier-dev/protocol/reviews/comments/content';
import { openReviewVerdictContentV1 } from '@happier-dev/protocol/reviews/reviewHumanV1';
import type { StoredJsonContentEnvelope } from '@happier-dev/protocol/storage/storedJsonContentEnvelope';
import type { Tx } from '@/storage/inTx';
import { prismaRuntime as Prisma } from '@/storage/prisma';
import { portableQueryChunks } from '@/storage/portableQueryChunks';
import { isReviewCommentCanonicalSensitiveLayout, buildStoredReviewCommentFromStorageRow, buildReviewCommentStoredEventFromStorageRow,
    type ReviewCommentMigrationStorageCommentRow, type ReviewCommentMigrationStorageEventRow } from '@/app/reviews/comments/accountEncryptionMigrationPersistence';

type Graph = ArtifactReviewGraphAccountEncryptionMigrationV1;
export type ArtifactReviewGraphCensusRow = Readonly<{
    id: string;
    reviewComments?: readonly Readonly<{ id: string }>[];
    reviewVerdicts?: readonly Readonly<{ reviewId: string; roundOrdinal: number; accountId: string; revision: number; content: unknown }>[];
}>;

/** One batched resource census; attribution never determines graph ownership. */
export async function readArtifactReviewGraphsInTx(tx: Tx, rows: readonly ArtifactReviewGraphCensusRow[]): Promise<ReadonlyMap<string, Graph>> {
    const ids = rows.filter(row => row.reviewComments?.length).map(row => row.id);
    const comments: ReviewCommentMigrationStorageCommentRow[] = [];
    const events: ReviewCommentMigrationStorageEventRow[] = [];
    for (const page of portableQueryChunks({ values: ids, bindingsPerValue: 1, fixedBindings: 0 })) {
        comments.push(...await tx.$queryRaw<ReviewCommentMigrationStorageCommentRow[]>(Prisma.sql`
            SELECT * FROM review_comments WHERE review_id IN (${Prisma.join([...page])}) ORDER BY id ASC`));
        events.push(...await tx.$queryRaw<ReviewCommentMigrationStorageEventRow[]>(Prisma.sql`
            SELECT e.*, c.review_id FROM review_comment_events e JOIN review_comments c ON c.id = e.comment_id
            WHERE c.review_id IN (${Prisma.join([...page])}) ORDER BY e.comment_id ASC, e.server_revision ASC, e.event_id ASC`));
    }
    const eventsByComment = new Map<string, Graph['comments'][number]['events']>();
    for (const row of events) {
        BoundReviewCommentEventSensitiveEnvelopeV1Schema.parse(JSON.parse(row.event_envelope_json));
        const item = buildReviewCommentStoredEventFromStorageRow(row);
        const list = eventsByComment.get(row.comment_id) ?? [];
        list.push({ event: item.event, sensitiveEnvelope: item.sensitiveEnvelope });
        eventsByComment.set(row.comment_id, list);
    }
    const graphs = new Map<string, Graph>();
    for (const row of rows) {
        if (!row.reviewComments?.length && !row.reviewVerdicts?.length) continue;
        graphs.set(row.id, ArtifactReviewGraphAccountEncryptionMigrationV1Schema.parse({ comments: [], verdicts: [...row.reviewVerdicts ?? []] }));
    }
    for (const row of comments) {
        const graph = row.review_id && graphs.get(row.review_id);
        if (!graph) throw new Error('review_comment_migration_inventory_mismatch');
        if (!isReviewCommentCanonicalSensitiveLayout(row)) throw new Error('review_comment_legacy_sensitive_layout');
        graph.comments.push({ stored: buildStoredReviewCommentFromStorageRow(row), events: eventsByComment.get(row.id) ?? [] });
    }
    return new Map([...graphs].map(([id, graph]) => [id, ArtifactReviewGraphAccountEncryptionMigrationV1Schema.parse(graph)]));
}

function identities(graph: Graph) {
    return { comments: graph.comments.map(item => ({ structural: item.stored.structural,
        events: item.events.map(event => ({ event: event.event, binding: event.sensitiveEnvelope.binding })) })),
        verdicts: graph.verdicts.map(({ content, ...binding }) => ({ ...binding, hasContent: content !== null })) };
}

export function artifactReviewGraphMatches(actual: Graph | undefined, expected: Graph | undefined): boolean {
    return isDeepStrictEqual(actual ?? { comments: [], verdicts: [] }, expected ?? { comments: [], verdicts: [] });
}

/** Validate target envelopes at the migration boundary; client E2EE stays opaque. */
export async function artifactReviewGraphReplacementValid(reviewId: string, source: Graph | undefined, target: Graph | undefined, mode: 'plain' | 'e2ee'): Promise<boolean> {
    if (!source || !target) return source === target;
    if (!isDeepStrictEqual(identities(source), identities(target))) return false;
    const matchesMode = (value: StoredJsonContentEnvelope) => value.t === (mode === 'plain' ? 'plain' : 'encrypted');
    for (const item of target.comments) {
        const { structural, sensitiveEnvelope } = item.stored;
        if (structural.reviewId !== reviewId || !matchesMode(sensitiveEnvelope)
            || (mode === 'plain' && openReviewCommentSensitiveEnvelopeV1({ structural, envelope: sensitiveEnvelope, mode }).status !== 'available')) return false;
        for (const entry of item.events) {
            if (entry.event.reviewId !== reviewId || entry.event.commentId !== structural.id || !matchesMode(entry.sensitiveEnvelope.sensitive)
                || (mode === 'plain' && openReviewCommentEventSensitiveEnvelopeV1({ event: entry.event, bound: entry.sensitiveEnvelope, mode }).status !== 'available')) return false;
        }
    }
    for (const item of target.verdicts) {
        if (item.reviewId !== reviewId || (item.content && !matchesMode(item.content))) return false;
        if (mode === 'plain' && item.content) {
            try { await openReviewVerdictContentV1({ content: item.content, expected: item,
                open: async content => content.t === 'plain' ? content.v : null }); } catch { return false; }
        }
    }
    return true;
}

/** The Account transition fence holds the validated graph stable through the parent CAS and these writes. */
export async function writeArtifactReviewGraphInTx(tx: Tx, reviewId: string, source: Graph, target: Graph): Promise<void> {
    const conflict = () => { throw new Error('review_comment_migration_inventory_mismatch'); };
    for (let index = 0; index < source.comments.length; index++) {
        const item = source.comments[index]!;
        const next = target.comments[index]!;
        const stored = item.stored;
        const updated = await tx.reviewComment.updateMany({ where: { reviewId, id: stored.structural.id,
            serverRevision: stored.structural.serverRevision, bodyVersion: stored.structural.bodyVersion,
            bodyEnvelopeJson: JSON.stringify(stored.sensitiveEnvelope) }, data: { bodyEnvelopeJson: JSON.stringify(next.stored.sensitiveEnvelope) } });
        if (updated.count !== 1) conflict();
        for (let eventIndex = 0; eventIndex < item.events.length; eventIndex++) {
            const event = item.events[eventIndex]!;
            const replaced = await tx.reviewCommentEvent.updateMany({ where: { eventId: event.event.eventId,
                commentId: stored.structural.id, eventEnvelopeJson: JSON.stringify(event.sensitiveEnvelope) },
                data: { eventEnvelopeJson: JSON.stringify(next.events[eventIndex]!.sensitiveEnvelope) } });
            if (replaced.count !== 1) conflict();
        }
    }
    for (let index = 0; index < source.verdicts.length; index++) {
        const item = source.verdicts[index]!;
        if (item.content === null) continue;
        const updated = await tx.reviewVerdict.updateMany({ where: { reviewId, roundOrdinal: item.roundOrdinal, accountId: item.accountId,
            revision: item.revision, content: { equals: item.content as PrismaTypes.InputJsonObject } },
            // The boundary above validates plain verdicts; encrypted envelopes contain only their ciphertext string.
            data: { content: target.verdicts[index]!.content! as PrismaTypes.InputJsonObject } });
        if (updated.count !== 1) conflict();
    }
}
