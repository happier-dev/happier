import { REVIEW_FINDINGS_VERIFY_AND_FIX_INSTRUCTIONS_V1, renderReviewFindingsForVerifyV1 } from '../../reviews/reviewFindingsApplyInputV1.js';
import type { WorkspaceAnchorV1 } from '../../workspace/anchors/v1.js';
import type { ReviewCommentDraftMessageV1, ReviewCommentsV1 } from './reviewCommentsV1.js';

export function normalizeReviewCommentDraftBody(body: string): string {
  return String(body).trim();
}

export function hasReviewCommentDraftBody(draft: Pick<ReviewCommentDraftMessageV1, 'body'>): boolean {
  return normalizeReviewCommentDraftBody(draft.body).length > 0;
}

export function normalizeReviewCommentDraft(draft: ReviewCommentDraftMessageV1): ReviewCommentDraftMessageV1 | null {
  const body = normalizeReviewCommentDraftBody(draft.body);
  if (!body) return null;
  return body === draft.body ? draft : { ...draft, body };
}

export function normalizeReviewCommentDrafts(drafts: readonly ReviewCommentDraftMessageV1[]): ReviewCommentDraftMessageV1[] {
  return drafts.flatMap((draft) => {
    const normalized = normalizeReviewCommentDraft(draft);
    return normalized ? [normalized] : [];
  });
}

export function getReviewCommentDraftAnchorPrimaryLine(anchor: WorkspaceAnchorV1): number | null {
  if (anchor.kind === 'fileLine') return anchor.startLine;
  if (anchor.kind === 'diffLine') {
    const line = anchor.side === 'after' ? anchor.newLine : anchor.oldLine;
    return typeof line === 'number' && Number.isFinite(line) ? line : null;
  }
  return anchor.kind === 'line' ? anchor.line : anchor.startLine;
}

function formatLineHashSuffix(hashes: readonly (string | undefined)[]): string {
  const present = hashes.filter((hash): hash is string => typeof hash === 'string' && hash.length > 0);
  return present.length > 0 ? ` - ${present.join(' - ')}` : '';
}

export function formatReviewCommentDraftAnchorLabel(anchor: WorkspaceAnchorV1): string {
  if (anchor.kind === 'fileLine') return `L${anchor.startLine}${formatLineHashSuffix([anchor.lineHash])}`;
  if (anchor.kind === 'diffLine') {
    const line = getReviewCommentDraftAnchorPrimaryLine(anchor);
    return `${anchor.side === 'after' ? 'after' : 'before'} ${line == null ? 'L?' : `L${line}`}${formatLineHashSuffix([anchor.lineHash])}`;
  }
  const sideText = anchor.side ? `${anchor.side} ` : '';
  if (anchor.kind === 'line') return `${sideText}L${anchor.line}${formatLineHashSuffix([anchor.lineHash])}`;
  return `${sideText}L${anchor.startLine}-L${anchor.endLine}${formatLineHashSuffix([anchor.startLineHash, anchor.endLineHash])}`;
}

export function isReviewCommentDraftIncludedInPrompt(draft: ReviewCommentDraftMessageV1): boolean {
  return draft.includeInPrompt !== false;
}

export function filterReviewCommentDraftsIncludedInPrompt(drafts: readonly ReviewCommentDraftMessageV1[]): ReviewCommentDraftMessageV1[] {
  return drafts.filter(isReviewCommentDraftIncludedInPrompt);
}

export function buildReviewCommentsPromptText(params: Readonly<{
  drafts: readonly ReviewCommentDraftMessageV1[]; additionalMessage: string;
}>): string {
  const drafts = filterReviewCommentDraftsIncludedInPrompt(params.drafts).sort((a, b) => {
    if (a.filePath !== b.filePath) return a.filePath.localeCompare(b.filePath);
    const line = (getReviewCommentDraftAnchorPrimaryLine(a.anchor) ?? 0) - (getReviewCommentDraftAnchorPrimaryLine(b.anchor) ?? 0);
    return line || a.createdAt - b.createdAt;
  });
  const rendered = renderReviewFindingsForVerifyV1(drafts.map((draft) => ({
    id: draft.id, title: `${draft.filePath} (${formatReviewCommentDraftAnchorLabel(draft.anchor)})`,
    filePath: draft.filePath, summary: draft.body, anchor: draft.anchor, snapshot: draft.snapshot,
    anchorResolution: draft.anchorResolution,
  })));
  const message = params.additionalMessage.trim();
  const messageBlock = message.length > 0 ? `\n\nAdditional message:\n${message}` : '';
  return `${REVIEW_FINDINGS_VERIFY_AND_FIX_INSTRUCTIONS_V1}\n\n${rendered}${messageBlock}`.trimEnd() + '\n';
}

export function buildReviewCommentsDisplayText(params: Readonly<{ drafts: readonly ReviewCommentDraftMessageV1[] }>): string {
  return params.drafts.length === 0 ? 'Review comments' : `Review comments (${params.drafts.length})`;
}

export function buildReviewCommentsV1MetaPayload(params: Readonly<{
  sessionId: string; drafts: readonly ReviewCommentDraftMessageV1[];
}>): ReviewCommentsV1 {
  return { sessionId: params.sessionId, comments: normalizeReviewCommentDrafts(params.drafts).map((draft) => ({
    id: draft.id, filePath: draft.filePath, source: draft.source, anchor: draft.anchor,
    ...(draft.anchorResolution ? { anchorResolution: draft.anchorResolution } : {}),
    snapshot: { selectedLines: [...draft.snapshot.selectedLines], beforeContext: [...draft.snapshot.beforeContext],
      afterContext: [...draft.snapshot.afterContext] },
    body: draft.body, createdAt: draft.createdAt,
    ...(draft.includeInPrompt === undefined ? {} : { includeInPrompt: draft.includeInPrompt }),
  })) };
}

/** One renderer for ordinary composer input and host Actions using saved review evidence. */
export function buildReviewCommentsOutboundMessage(params: Readonly<{
  sessionId: string; drafts: readonly ReviewCommentDraftMessageV1[]; additionalMessage: string;
  displayTextSuffix?: string | null; metaOverrides?: Record<string, unknown> | null;
}>): Readonly<{ text: string; displayText: string; metaOverrides: Record<string, unknown> }> {
  const drafts = filterReviewCommentDraftsIncludedInPrompt(params.drafts);
  const displayTextBase = buildReviewCommentsDisplayText({ drafts });
  const displayTextSuffix = String(params.displayTextSuffix ?? '').trim();
  const metaOverrides = { ...params.metaOverrides };
  const envelope = metaOverrides.happier;
  if (metaOverrides.happierAttachments === undefined && envelope && typeof envelope === 'object'
    && !Array.isArray(envelope) && 'kind' in envelope && envelope.kind === 'attachments.v1' && 'payload' in envelope) {
    metaOverrides.happierAttachments = envelope;
  }
  return {
    text: buildReviewCommentsPromptText({ drafts, additionalMessage: params.additionalMessage }),
    displayText: displayTextSuffix.length > 0 ? `${displayTextBase}\n\n${displayTextSuffix}` : displayTextBase,
    metaOverrides: { ...metaOverrides, happier: { kind: 'review_comments.v1',
      payload: buildReviewCommentsV1MetaPayload({ sessionId: params.sessionId, drafts }) } },
  };
}
