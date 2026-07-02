import type { ReviewCommentSnapshotV1, ReviewCommentV1 } from '@happier-dev/protocol';

export type ReviewCommentBodyLabels = Readonly<{
    contentUnavailable: string;
}>;

export type ReviewCommentSnapshotEnvelopeLabels = Readonly<{
    contentUnavailable: string;
    encryptedSnapshot: string;
}>;

type ReviewCommentBodyContent = ReviewCommentV1['body'];
type ReviewCommentSnapshotContent = ReviewCommentV1['snapshot'];
type ContentEnvelope = Extract<ReviewCommentBodyContent | ReviewCommentSnapshotContent, { t: 'plain' | 'encrypted' }>;

function recordValue(value: unknown): Record<string, unknown> | null {
    return typeof value === 'object' && value !== null ? value as Record<string, unknown> : null;
}

function isContentEnvelope(value: unknown): value is ContentEnvelope {
    const record = recordValue(value);
    return record?.t === 'plain' || record?.t === 'encrypted';
}

function isReviewCommentSnapshot(value: unknown): value is ReviewCommentSnapshotV1 {
    const record = recordValue(value);
    const kind = record?.kind;
    return kind === 'text'
        || kind === 'binary'
        || kind === 'submodule'
        || kind === 'symlink'
        || kind === 'too_large';
}

export function resolveReviewCommentBodyText(
    body: ReviewCommentBodyContent,
    labels: ReviewCommentBodyLabels,
): string {
    if (typeof body === 'string') return body;
    if (body.t === 'plain' && typeof body.v === 'string') return body.v;
    return labels.contentUnavailable;
}

export function resolveReviewCommentBodyPromptDefault(body: ReviewCommentBodyContent): string | undefined {
    if (typeof body === 'string') return body;
    return body.t === 'plain' && typeof body.v === 'string' ? body.v : undefined;
}

export function resolveReviewCommentSnapshot(snapshot: ReviewCommentSnapshotContent): ReviewCommentSnapshotV1 | null {
    if (isReviewCommentSnapshot(snapshot)) return snapshot;
    if (snapshot.t === 'plain' && isReviewCommentSnapshot(snapshot.v)) return snapshot.v;
    return null;
}

export function resolveReviewCommentSnapshotEnvelopeLabel(
    snapshot: ReviewCommentSnapshotContent,
    labels: ReviewCommentSnapshotEnvelopeLabels,
): string | null {
    if (!isContentEnvelope(snapshot)) return null;
    return snapshot.t === 'encrypted' ? labels.encryptedSnapshot : labels.contentUnavailable;
}
