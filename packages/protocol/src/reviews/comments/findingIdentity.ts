import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';

import { computeCanonicalDomainSeparatedHexDigest } from '../../crypto/canonicalDigest.js';
import type { ReviewCommentFingerprintV1, ReviewCommentV1 } from './v1.js';

export type ReviewCommentFindingScopeV1 = readonly [
  readonly ['workspace', string, string] | readonly ['project', string | undefined],
  string,
  string | null,
];

/** The persisted semantic-dedupe scope: a workspace dominates incidental Project linkage. */
export function reviewCommentFindingScopeV1(comment: Pick<ReviewCommentV1,
  'findingIdentity' | 'parentCommentId' | 'workspace' | 'projectId' | 'sessionId'>): ReviewCommentFindingScopeV1 | null {
  if (!comment.findingIdentity || comment.parentCommentId) return null;
  return [comment.workspace ? ['workspace', comment.workspace.machineId, comment.workspace.path] : ['project', comment.projectId],
    comment.findingIdentity, comment.sessionId ?? null];
}

export const ReviewFindingIdentityV1Schema = lazyZodSchema(() => z.string().regex(/^[a-f0-9]{64}$/));
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
