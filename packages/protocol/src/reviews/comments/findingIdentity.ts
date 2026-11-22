import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

import { computeCanonicalDomainSeparatedHexDigest } from '../../crypto/canonicalDigest.js';
import type { ReviewCommentFingerprintV1, ReviewCommentV1 } from './v1.js';
import type { ReviewArtifactBodyV1, ReviewRoundBindingV1 } from '../reviewArtifactV1.js';

export type ReviewFindingRoundContextV1 = Readonly<ReviewRoundBindingV1 &
  Pick<ReviewArtifactBodyV1['rounds'][number], 'state' | 'reviewerIds'>>;
export type ReviewFindingRoundStatusV1 = 'new' | 'still_there' | 'looks_addressed' | 'unknown';

/** Appearance evidence never changes the person's independent finding decision. */
export function projectReviewFindingRoundStatusV1(
  comment: Pick<ReviewCommentV1, 'reviewId' | 'findingIdentity' | 'parentCommentId' | 'appearances'>,
  round: ReviewFindingRoundContextV1,
): ReviewFindingRoundStatusV1 | null {
  if (comment.reviewId !== round.reviewId || !comment.findingIdentity || comment.parentCommentId) return null;
  const appearances = comment.appearances ?? [];
  const earlier = appearances.some(appearance => appearance.roundOrdinal < round.roundOrdinal);
  if (appearances.some(appearance => appearance.roundOrdinal === round.roundOrdinal)) return earlier ? 'still_there' : 'new';
  return earlier && round.state === 'completed' && round.reviewerIds.length > 0 ? 'looks_addressed' : 'unknown';
}

export type ReviewCommentFindingScopeV1 = readonly ['review', string, string] | readonly [
  readonly ['workspace', string, string] | readonly ['project', string | undefined],
  string,
  string | null,
];

/** A bound Review owns identity; private findings keep their workspace/Session scope. */
export function reviewCommentFindingScopeV1(comment: Pick<ReviewCommentV1,
  'reviewId' | 'findingIdentity' | 'parentCommentId' | 'workspace' | 'projectId' | 'sessionId'>): ReviewCommentFindingScopeV1 | null {
  if (!comment.findingIdentity || comment.parentCommentId) return null;
  if (comment.reviewId) return ['review', comment.reviewId, comment.findingIdentity];
  return [comment.workspace ? ['workspace', comment.workspace.machineId, comment.workspace.path] : ['project', comment.projectId],
    comment.findingIdentity, comment.sessionId ?? null];
}

/**
 * A finding comment's own explanation once someone revised it (the reviewer answering a question, a person editing).
 * Its first version is the reviewer's finding written out, which the finding's own fields already say, so a reader
 * shows the finding then; an unreadable body says nothing either.
 */
export function readReviewFindingRevisedBodyV1(comment: Pick<ReviewCommentV1, 'body' | 'bodyVersion' | 'finding'>): string | undefined {
  if (!comment.finding || comment.bodyVersion <= 1) return undefined;
  const body = comment.body;
  if (typeof body === 'string') return body;
  return body.t === 'plain' && typeof body.v === 'string' ? body.v : undefined;
}

export const ReviewFindingIdentityV1Schema = lazyZodSchema(() => z.string().check(z.regex(/^[a-f0-9]{64}$/)));
export type ReviewFindingIdentityV1 = z.infer<typeof ReviewFindingIdentityV1Schema>;

/** Whitespace and casing are presentation; file bytes, location and engine are currentness. */
export function normalizeReviewFindingTextV1(value: string): string {
  return value.normalize('NFC').trim().replace(/\s+/gu, ' ').toLowerCase();
}

export function createReviewFindingMessageHashV1(message: string): string {
  return computeCanonicalDomainSeparatedHexDigest('happier.reviewFindingMessage.v1', [normalizeReviewFindingTextV1(message)]);
}

/** One semantic finding across review rounds and engines, independent of line/file changes. */
export function createReviewFindingIdentityV1(input: Readonly<{
  path?: string;
  title: string;
  fingerprint: ReviewCommentFingerprintV1;
}>): ReviewFindingIdentityV1 {
  const path = (input.path ?? '').normalize('NFC').replace(/\\/gu, '/').replace(/^(?:\.\/)+/u, '');
  return computeCanonicalDomainSeparatedHexDigest('happier.reviewFindingIdentity.v1', [
    path,
    input.fingerprint.ruleId ?? normalizeReviewFindingTextV1(input.title),
    input.fingerprint.normalizedMessageHash,
  ]);
}
