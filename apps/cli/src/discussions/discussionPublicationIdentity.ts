import { createHash } from 'node:crypto';

/** The approved operation owns omitted retry keys, independently of its optional Artifact. */
export function deriveApprovedDiscussionMutationLocalId(params: Readonly<{
  requestId: string;
  purpose: 'creation' | 'first_message' | 'post';
}>): string {
  return `approved-discussion-v1:${createHash('sha256').update(JSON.stringify([
    'happier.discussion-approved-mutation.v1', params.requestId, params.purpose,
  ])).digest('base64url')}`;
}
