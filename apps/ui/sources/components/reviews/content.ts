import type { ReviewCommentSnapshotV1, ReviewCommentV1 } from '@happier-dev/protocol/reviews/comments/v1';

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
    return kind === 'none'
        || kind === 'text'
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

export type ReviewCommentBodyParts = Readonly<{
    /** A short first line standing alone (a review finding's title), drawn as the card's title. */
    title: string | null;
    /** What the card shows folded: the first paragraph after the title. */
    lead: string;
    /** Everything after the lead, behind "Show more"; empty when there is nothing more. */
    rest: string;
}>;

/**
 * Splits a comment body the way a finding card reads: title, the summary it leads with, then the
 * detail folded away. A finding's comment is written as paragraphs (title, summary, why, evidence,
 * suggestion) whose title is one line without closing punctuation; a one-paragraph comment has no
 * title and nothing to fold.
 */
export function splitReviewCommentBody(text: string): ReviewCommentBodyParts {
    const paragraphs = text.split(/\n\s*\n/).map((paragraph) => paragraph.trim()).filter(Boolean);
    const first = paragraphs[0] ?? '';
    const titled = paragraphs.length > 1
        && !first.includes('\n')
        && !/[:.]$/.test(first);
    const body = titled ? paragraphs.slice(1) : paragraphs;
    return {
        title: titled ? first : null,
        lead: body[0] ?? '',
        rest: body.slice(1).join('\n\n'),
    };
}

/** Where a comment points, as one place ("src/a.ts:12", "src/a.ts:3–7", a file or a folder); `null` when nowhere. */
export function formatReviewCommentAnchor(comment: Pick<ReviewCommentV1, 'anchor'>): string | null {
    const anchor = comment.anchor;
    if (anchor.kind === 'line') return `${anchor.filePath}:${anchor.line}`;
    if (anchor.kind === 'range') {
        return anchor.startLine === anchor.endLine
            ? `${anchor.filePath}:${anchor.startLine}`
            : `${anchor.filePath}:${anchor.startLine}–${anchor.endLine}`;
    }
    if ('filePath' in anchor) return anchor.filePath;
    if ('folderPath' in anchor) return anchor.folderPath;
    return null;
}
