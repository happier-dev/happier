import { describe, expect, it } from 'vitest';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { splitReviewCommentV1, sealReviewCommentSensitiveEnvelopeV1, openReviewCommentSensitiveEnvelopeV1,
  bindReviewCommentEventSensitiveEnvelopeV1, openReviewCommentEventSensitiveEnvelopeV1,
  ReviewCommentEventSensitivePayloadV1Schema, REVIEW_COMMENT_RESOURCE_COMMITMENT_DOMAIN_V1 } from './content.js';
import { executeReviewCommentTransportV1 } from './transport.js';
import { deriveReviewCommentStructuralMutationV1, ReviewCommentPrepareMutationRequestV1Schema, ReviewCommentCommitMutationRequestV1Schema } from './mutation.js';
import { computeCanonicalDomainSeparatedKeyedDigest } from '../../crypto/canonicalDigest.js';

const workspace = { machineId: 'machine-1', path: '/repo' };
const comment = { v: 1 as const, id: 'comment-1', reviewId: 'review-1', accountId: 'author-account', workspace,
  anchor: { kind: 'file' as const, filePath: 'private.ts' }, snapshot: { kind: 'none' as const, capturedAt: 1 },
  body: 'private collaborator body', bodyVersion: 1, edits: [], author: { kind: 'user' as const, userId: 'author-account' },
  state: 'open' as const, flags: {}, dispositions: {}, threadId: 'comment-1', transitions: [],
  createdAt: 1, updatedAt: 1, serverRevision: 1 };

// The Artifact codec is a real encryption boundary; the recipient owns no Account key.
function resourceCodec(reviewId = 'review-1') {
  const key = new Uint8Array(32).fill(19);
  return { reviewId, mode: 'e2ee' as const,
    seal: async (value: unknown) => {
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, nonce);
      const encrypted = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
      return { t: 'encrypted' as const, c: Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString('base64') };
    },
    open: async (envelope: { t: 'plain'; v: unknown } | { t: 'encrypted'; c: string }) => {
      if (envelope.t !== 'encrypted') throw new Error('mode mismatch');
      const bytes = Buffer.from(envelope.c, 'base64');
      const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28));
      return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString());
    },
    commitment: (purpose: string, canonicalInput: string) => computeCanonicalDomainSeparatedKeyedDigest(key,
      REVIEW_COMMENT_RESOURCE_COMMITMENT_DOMAIN_V1, [reviewId, purpose, canonicalInput]),
  };
}

describe('Review resource content binding', () => {
  it('binds the same comment and revision to one Review', () => {
    const split = splitReviewCommentV1(comment);
    const envelope = sealReviewCommentSensitiveEnvelopeV1({ ...split, mode: 'plain' });
    expect(openReviewCommentSensitiveEnvelopeV1({ structural: split.structural, envelope, mode: 'plain' }).status).toBe('available');
    expect(openReviewCommentSensitiveEnvelopeV1({ structural: { ...split.structural, reviewId: 'another-review' }, envelope,
      mode: 'plain' })).toMatchObject({ status: 'locked', reason: 'content_binding_mismatch' });
  });

  it('opens collaborator content using the admitted resource codec without an author Account key', async () => {
    const split = splitReviewCommentV1(comment);
    const plain = sealReviewCommentSensitiveEnvelopeV1({ ...split, mode: 'plain' });
    if (plain.t !== 'plain') throw new Error('Expected logical payload');
    const resource = resourceCodec();
    const stored = { v: 1, structural: split.structural, sensitiveEnvelope: await resource.seal(plain.v) };
    const execute = (reviewId = 'review-1') => executeReviewCommentTransportV1({
      actionId: 'reviews.comments.get', input: { commentId: comment.id, reviewId },
      context: { accountId: 'recipient-account', mode: 'e2ee', material: null, resource: { ...resource, reviewId } },
      actor: { kind: 'user', userId: 'recipient-account' }, randomBytes,
      request: async () => ({ comment: stored }),
    });
    expect(await execute()).toMatchObject({ comment: { body: comment.body, reviewId: 'review-1', accountId: 'author-account' } });
    await expect(execute('another-review')).rejects.toMatchObject({ code: 'review_comment_content_binding_mismatch' });
  });

  it('discovers the Review codec from an authorized ID-only stored read without an Account key', async () => {
    const split = splitReviewCommentV1(comment);
    const plain = sealReviewCommentSensitiveEnvelopeV1({ ...split, mode: 'plain' });
    if (plain.t !== 'plain') throw new Error('Expected logical payload');
    const resource = resourceCodec();
    const stored = { v: 1, structural: split.structural, sensitiveEnvelope: await resource.seal(plain.v) };
    const resolved: (string | undefined)[] = [];
    let reads = 0;
    const request = {
      actionId: 'reviews.comments.get' as const, input: { commentId: comment.id },
      context: { accountId: 'recipient-account', mode: 'plain' as const, material: null },
      actor: { kind: 'user' as const, userId: 'recipient-account' }, randomBytes,
      resolveContext: async (reviewId?: string) => {
        resolved.push(reviewId);
        return { accountId: 'recipient-account', mode: resource.mode, material: null, resource };
      },
      request: async () => { reads++; return { comment: stored }; },
    };
    await expect(executeReviewCommentTransportV1(request)).resolves.toEqual({ comment });
    expect(resolved).toEqual([comment.reviewId]);
    expect(reads).toBe(1);
    resolved.length = 0;
    const refusal = Object.assign(new Error('review_comment_not_found'), { code: 'review_comment_not_found' });
    await expect(executeReviewCommentTransportV1({ ...request, request: async () => { throw refusal; } })).rejects.toBe(refusal);
    expect(resolved).toEqual([]);
  });

  it('seals new records and events under the same Review key through prepare and commit', async () => {
    const resource = resourceCodec();
    const input = { reviewId: 'review-1', roundOrdinal: 2, workspace, anchor: comment.anchor, snapshot: comment.snapshot,
      body: comment.body, clientMutationId: 'resource-create', authorIntent: 'open' };
    let sequence = 0;
    const actor = { kind: 'user' as const, userId: 'recipient-account' };
    let derived: ReturnType<typeof deriveReviewCommentStructuralMutationV1> | undefined;
    let serverBytes = '';
    const result = await executeReviewCommentTransportV1({ actionId: 'reviews.comments.create', input,
      context: { accountId: actor.userId, mode: resource.mode, material: null, resource }, actor, randomBytes,
      request: async (request) => {
        serverBytes += JSON.stringify(request.body);
        if (request.path.endsWith('/prepare')) {
          const prepared = ReviewCommentPrepareMutationRequestV1Schema.parse(request.body);
          derived = deriveReviewCommentStructuralMutationV1({ mutation: prepared.mutation, accountId: 'review-owner-account',
            actor, current: [], runtime: { now: () => 2, createId: prefix => `${prefix}-${++sequence}` } });
          return { v: 1, receipt: 'admitted-resource', request: prepared, ...derived, replayed: false };
        }
        const commit = ReviewCommentCommitMutationRequestV1Schema.parse(request.body);
        if (!derived) throw new Error('Expected admission');
        const eventEnvelope = commit.records[0]!.eventEnvelope;
        if (!eventEnvelope) throw new Error('Expected confidential event');
        expect(await resource.open(eventEnvelope)).toMatchObject({ requestBinding: { reviewId: 'review-1', accountId: actor.userId },
          binding: { reviewId: 'review-1', accountId: 'review-owner-account', eventId: derived.records[0]!.event!.eventId,
            commentId: derived.records[0]!.structural.id, serverRevision: 1 }, details: { body: comment.body } });
        const payload = ReviewCommentEventSensitivePayloadV1Schema.parse(await resource.open(eventEnvelope));
        const event = derived.records[0]!.event!;
        const bound = bindReviewCommentEventSensitiveEnvelopeV1({ event, requestBinding: payload.requestBinding,
          sensitive: { t: 'plain', v: payload } });
        expect(openReviewCommentEventSensitiveEnvelopeV1({ event, bound, mode: 'plain' }).status).toBe('available');
        const swappedEvent = { ...event, eventId: 'different-event' };
        const swappedBound = bindReviewCommentEventSensitiveEnvelopeV1({ event: swappedEvent,
          requestBinding: payload.requestBinding, sensitive: bound.sensitive });
        expect(openReviewCommentEventSensitiveEnvelopeV1({ event: swappedEvent, bound: swappedBound,
          mode: 'plain' })).toMatchObject({ status: 'locked', reason: 'event_binding_mismatch' });
        return { v: 1, comments: derived.records.map((record, index) => ({ v: 1,
          structural: record.structural, sensitiveEnvelope: commit.records[index]!.sensitiveEnvelope })), replayed: false, failed: [] };
      },
    });
    expect(result).toMatchObject({ comment: { reviewId: 'review-1', roundOrdinal: 2, accountId: 'review-owner-account', body: comment.body, author: actor } });
    expect(serverBytes).not.toContain(comment.body);
    expect(serverBytes).not.toContain(comment.anchor.filePath);
  });
});
