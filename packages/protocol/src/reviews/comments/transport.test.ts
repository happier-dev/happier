import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { executeReviewCommentTransportV1, buildReviewCommentCreateEquivalenceCommitmentV1, type ReviewCommentTransportContextV1 } from './transport.js';
import {
  deriveReviewCommentStructuralMutationV1, ReviewCommentPrepareMutationRequestV1Schema,
  ReviewCommentCommitMutationRequestV1Schema, type ReviewCommentPreparedRecordV1,
} from './mutation.js';
import { openStoredReviewCommentV1, splitReviewCommentV1, sealReviewCommentSensitiveEnvelopeV1, type StoredReviewCommentV1 } from './content.js';
import { ReviewCommentActionOutputSchemasV1, type ReviewCommentActionIdV1 } from './actions.js';
import type { ReviewCommentV1 } from './v1.js';

const context: ReviewCommentTransportContextV1 = { accountId: 'account-1', mode: 'e2ee',
  material: { type: 'dataKey', machineKey: new Uint8Array(32).fill(7) } };
const actor = { kind: 'user' as const, userId: 'account-1' };
const workspace = { machineId: 'machine-1', path: '/repo' };
const create = { workspace, anchor: { kind: 'file' as const, filePath: 'a.ts' },
  snapshot: { kind: 'none' as const, capturedAt: 1 }, body: 'PRIVATE-body', authorIntent: 'open' as const,
  clientMutationId: 'create-1', fingerprint: { normalizedMessageHash: 'public-dedupe', ruleId: 'PRIVATE-rule' },
  metadata: { tags: ['PRIVATE-tag'], taxonomyIds: ['PRIVATE-taxonomy'], reviewGroupIds: ['PRIVATE-group'] } };

describe('canonical Review Comment client transport', () => {
  it('retains classic validation errors and issue paths for malformed stored responses', async () => {
    const result = executeReviewCommentTransportV1({
      actionId: 'reviews.comments.get', input: { commentId: 'comment-1' },
      context: { accountId: 'account-1', mode: 'plain', material: null }, actor,
      request: async () => ({ comment: null, extra: true }),
      randomBytes: (length) => new Uint8Array(length),
    });
    await expect(result).rejects.toBeInstanceOf(z.ZodError);
    await expect(result).rejects.toMatchObject({ issues: [
      { code: 'invalid_union', path: ['comment'] },
      { code: 'unrecognized_keys', path: [], keys: ['extra'] },
    ] });
  });
  it('rejects a same-scope prepared previous record for another target before sealing or committing', async () => {
    const previous: ReviewCommentV1 = { v: 1, id: 'other-comment', accountId: context.accountId, workspace,
      anchor: create.anchor, snapshot: create.snapshot, body: 'Other private content', bodyVersion: 1, edits: [], author: actor,
      state: 'open', flags: {}, dispositions: {}, threadId: 'other-comment', transitions: [], createdAt: 1, updatedAt: 1, serverRevision: 1 };
    const split = splitReviewCommentV1(previous);
    const envelope = sealReviewCommentSensitiveEnvelopeV1({ ...split, mode: 'e2ee', material: context.material!,
      randomBytes: (length) => new Uint8Array(length).fill(95) });
    let commits = 0;
    let prepared: ReviewCommentPreparedRecordV1 | undefined;
    const result = executeReviewCommentTransportV1({ actionId: 'reviews.comments.edit',
      input: { workspace, commentId: 'expected-comment', expectedServerRevision: 1, expectedBodyVersion: 1,
        nextBody: 'Caller intended update', clientMutationId: 'edit-1' }, context, actor,
      randomBytes: (length) => new Uint8Array(length).fill(96), request: async (request) => {
        if (request.path.endsWith('/prepare')) {
          const body = ReviewCommentPrepareMutationRequestV1Schema.parse(request.body);
          if (body.mutation.actionId !== 'reviews.comments.edit') throw new Error('Unexpected action');
          const mutation = { ...body.mutation, input: { ...body.mutation.input, commentId: previous.id } };
          const derived = deriveReviewCommentStructuralMutationV1({ mutation, accountId: context.accountId, actor,
            current: [split.structural], runtime: { now: () => 2, createId: (prefix) => `${prefix}-1` } });
          prepared = { ...derived.records[0]!, previous: { structural: split.structural,
            source: { v: 1, layout: 'canonical_v1', envelope } } };
          return { v: 1, receipt: 'receipt', request: body, records: [prepared], replayed: false, failed: [] };
        }
        commits++;
        const body = ReviewCommentCommitMutationRequestV1Schema.parse(request.body);
        return { v: 1, comments: [{ v: 1, structural: prepared!.structural,
          sensitiveEnvelope: body.records[0]!.sensitiveEnvelope }], replayed: false, failed: [] };
      },
    });
    await expect(result).rejects.toMatchObject({ code: 'review_comment_content_binding_mismatch' });
    expect(commits).toBe(0);
  });

  it('accepts an authorized late equivalent-create winner without rewriting its content or rebinding the fresh event', async () => {
    const semanticInput = { ...create, findingIdentity: 'a'.repeat(64), projectId: 'project-new', workspaceId: 'workspace-new' };
    const authorized = deriveReviewCommentStructuralMutationV1({ mutation: {
      actionId: 'reviews.comments.create', input: { workspace, anchorIndex: { kind: 'file' }, clientMutationId: 'create-1', authorIntent: 'open',
        findingIdentity: semanticInput.findingIdentity, projectId: semanticInput.projectId, workspaceId: semanticInput.workspaceId },
    }, accountId: context.accountId, actor, current: [], runtime: { now: () => 100, createId: (prefix) => `${prefix}-fresh` } }).records[0]!;
    const existing: ReviewCommentV1 = { v: 1, id: 'retained-comment', accountId: context.accountId, workspace,
      projectId: 'project-old', workspaceId: 'workspace-old', findingIdentity: semanticInput.findingIdentity,
      anchor: create.anchor, snapshot: create.snapshot, body: 'Retained content', bodyVersion: 1, edits: [], author: actor,
      state: 'open', flags: {}, dispositions: {}, threadId: 'retained-comment', transitions: [], createdAt: 1, updatedAt: 2, serverRevision: 5 };
    const split = splitReviewCommentV1(existing);
    const stored: StoredReviewCommentV1 = { v: 1, structural: split.structural,
      sensitiveEnvelope: sealReviewCommentSensitiveEnvelopeV1({ ...split, mode: 'e2ee', material: context.material!,
        randomBytes: (length) => new Uint8Array(length).fill(91) }) };
    let sent: unknown;
    const execute = (record: StoredReviewCommentV1, replayAtPrepare = false) => executeReviewCommentTransportV1({ actionId: 'reviews.comments.create',
      input: semanticInput, context, actor, randomBytes: (length) => new Uint8Array(length).fill(92),
      request: async (request) => {
        if (request.path.endsWith('/prepare')) return { v: 1, receipt: 'receipt', request: request.body,
          records: replayAtPrepare ? [{ structural: record.structural, previous: { structural: record.structural,
            source: { v: 1, layout: 'canonical_v1', envelope: record.sensitiveEnvelope } } }] : [authorized],
          replayed: replayAtPrepare, failed: [] };
        sent = request.body;
        return { v: 1, comments: [record], replayed: true, failed: [] };
      },
    });
    await expect(execute(stored)).resolves.toEqual({ comment: existing, replayed: true });
    expect(ReviewCommentCommitMutationRequestV1Schema.parse(sent).records[0]?.commentId).toBe(authorized.structural.id);
    await expect(execute(stored, true)).resolves.toEqual({ comment: existing, replayed: true });
    expect(ReviewCommentCommitMutationRequestV1Schema.parse(sent).records).toEqual([]);
    await expect(execute({ ...stored, structural: { ...stored.structural, workspace: { ...workspace, path: '/other' } } })).rejects.toMatchObject({ code: 'review_comment_content_binding_mismatch' });
  });

  it('preserves a commit-time bulk CAS failure without accepting an unexplained missing row', async () => {
    const previous: ReviewCommentV1 = { v: 1, id: 'comment-1', accountId: context.accountId, workspace,
      anchor: create.anchor, snapshot: create.snapshot, body: create.body, bodyVersion: 1, edits: [], author: actor,
      state: 'open', flags: {}, dispositions: {}, threadId: 'comment-1', transitions: [], createdAt: 1, updatedAt: 1, serverRevision: 1 };
    const split = splitReviewCommentV1(previous);
    const envelope = sealReviewCommentSensitiveEnvelopeV1({ ...split, mode: 'e2ee', material: context.material!,
      randomBytes: (length) => new Uint8Array(length).fill(93) });
    const input = { workspace, commentIds: [previous.id], expectedServerRevisions: { [previous.id]: 1 },
      expectedState: 'open', toState: 'resolved', reason: 'PRIVATE-resolution', clientMutationId: 'bulk-race' };
    const execute = (failures: unknown[]) => executeReviewCommentTransportV1({ actionId: 'reviews.comments.bulkTransition',
      input, context, actor, randomBytes: (length) => new Uint8Array(length).fill(94),
      request: async (request) => {
        if (request.path.endsWith('/prepare')) {
          const body = ReviewCommentPrepareMutationRequestV1Schema.parse(request.body);
          const result = deriveReviewCommentStructuralMutationV1({ mutation: body.mutation, accountId: context.accountId,
            actor, current: [split.structural], runtime: { now: () => 2, createId: (prefix) => `${prefix}-bulk` } });
          return { v: 1, receipt: 'receipt', request: body, ...result, replayed: false,
            records: result.records.map((record) => ({ ...record, previous: { structural: split.structural,
              source: { v: 1, layout: 'canonical_v1', envelope } } })) };
        }
        return { v: 1, comments: [], failed: failures, replayed: false, bulkActionId: 'review-comment-bulk-bulk' };
      },
    });
    const failures = [{ commentId: previous.id, errorCode: 'review_comment_conflict', error: 'Concurrent change' }];
    await expect(execute(failures)).resolves.toMatchObject({ updated: [], failed: failures });
    await expect(execute([])).rejects.toMatchObject({ code: 'review_comment_content_binding_mismatch' });
    await expect(execute([{ ...failures[0], commentId: 'unrelated' }])).rejects.toMatchObject({ code: 'review_comment_content_binding_mismatch' });
  });

  it('seals complete revised records for every CRUD operation and keeps sensitive fields off the real HTTP boundary', async () => {
    const stored = new Map<string, StoredReviewCommentV1>();
    const wire: unknown[] = [];
    let prepared: readonly ReviewCommentPreparedRecordV1[] = [];
    let sequence = 0;
    let nonce = 0;
    let failures: unknown[] = [];
    let bulkActionId: string | undefined;
    const run = (actionId: Exclude<ReviewCommentActionIdV1, 'reviews.comments.claimPublicationDispatch'>, input: Record<string, unknown>) => executeReviewCommentTransportV1({
      actionId, input, context, actor, randomBytes: (length) => new Uint8Array(length).fill(++nonce),
      request: async (request) => {
        wire.push(request);
        if (request.path.endsWith('/mutations/prepare')) {
          const body = ReviewCommentPrepareMutationRequestV1Schema.parse(request.body);
          const result = deriveReviewCommentStructuralMutationV1({ mutation: body.mutation, accountId: context.accountId,
            actor, current: [...stored.values()].map((item) => item.structural), runtime: { now: () => 100 + sequence,
              createId: (prefix) => `${prefix}-${++sequence}` } });
          prepared = result.records.map((record) => {
            const previousId = body.mutation.actionId === 'reviews.comments.reply' ? body.mutation.input.parentCommentId : record.structural.id;
            const prior = stored.get(previousId);
            return { ...record, ...(prior ? { previous: { structural: prior.structural,
              source: { v: 1 as const, layout: 'canonical_v1' as const, envelope: prior.sensitiveEnvelope } } } : {}) };
          });
          failures = result.failed;
          bulkActionId = result.bulkActionId;
          return { v: 1, receipt: 'receipt-1', request: body, records: prepared, replayed: false, failed: failures, bulkActionId };
        }
        const body = ReviewCommentCommitMutationRequestV1Schema.parse(request.body);
        const comments = body.records.map((item) => {
          const structural = prepared.find((candidate) => candidate.structural.id === item.commentId)!.structural;
          const record: StoredReviewCommentV1 = { v: 1, structural, sensitiveEnvelope: item.sensitiveEnvelope };
          expect(openStoredReviewCommentV1({ stored: record, mode: 'e2ee', material: context.material! }).status).toBe('available');
          stored.set(structural.id, record);
          return record;
        });
        return { v: 1, comments, replayed: false, failed: failures, bulkActionId };
      },
    });
    let { comment } = ReviewCommentActionOutputSchemasV1['reviews.comments.create'].parse(await run('reviews.comments.create', create));
    const input = () => ({ workspace, commentId: comment.id, expectedServerRevision: comment.serverRevision });
    comment = ReviewCommentActionOutputSchemasV1['reviews.comments.edit'].parse(await run('reviews.comments.edit', {
      ...input(), expectedBodyVersion: 1, nextBody: 'PRIVATE-edited', reason: 'PRIVATE-edit-reason', clientMutationId: 'edit-1',
    })).comment;
    expect(comment).toMatchObject({ body: 'PRIVATE-edited', bodyVersion: 2, edits: [{ previousBody: create.body, nextBody: 'PRIVATE-edited' }] });
    comment = ReviewCommentActionOutputSchemasV1['reviews.comments.attachEvidence'].parse(await run('reviews.comments.attachEvidence', {
      ...input(), evidence: [{ kind: 'reasoning', message: 'PRIVATE-evidence' }], clientMutationId: 'evidence-1',
    })).comment;
    comment = ReviewCommentActionOutputSchemasV1['reviews.comments.transition'].parse(await run('reviews.comments.transition', {
      ...input(), expectedState: 'open', toState: 'open', reviewGroupId: 'PRIVATE-new-group', reviewTriageStatus: 'defer',
      reason: 'PRIVATE-defer', clientMutationId: 'transition-1',
    })).comment;
    expect(comment.metadata?.reviewGroupIds).toEqual(['PRIVATE-group', 'PRIVATE-new-group']);
    comment = ReviewCommentActionOutputSchemasV1['reviews.comments.setDisposition'].parse(await run('reviews.comments.setDisposition', {
      ...input(), disposition: 'blocking', clientMutationId: 'disposition-1',
    })).comment;
    const reply = ReviewCommentActionOutputSchemasV1['reviews.comments.reply'].parse(await run('reviews.comments.reply', {
      workspace, parentCommentId: comment.id, expectedParentServerRevision: comment.serverRevision,
      body: 'PRIVATE-reply', clientMutationId: 'reply-1',
    }));
    expect(reply.parent).toEqual(comment);
    expect(reply.comment).toMatchObject({ body: 'PRIVATE-reply', parentCommentId: comment.id, threadId: comment.threadId });
    const bulk = ReviewCommentActionOutputSchemasV1['reviews.comments.bulkTransition'].parse(await run('reviews.comments.bulkTransition', {
      workspace, commentIds: [comment.id, 'missing'], expectedServerRevisions: { [comment.id]: comment.serverRevision, missing: 1 },
      expectedState: 'open', toState: 'resolved', reason: 'PRIVATE-resolution', clientMutationId: 'bulk-1',
    }));
    expect(bulk.failed).toMatchObject([{ commentId: 'missing', errorCode: 'review_comment_not_found' }]);
    comment = bulk.updated[0]!;
    comment = ReviewCommentActionOutputSchemasV1['reviews.comments.redact'].parse(await run('reviews.comments.redact', {
      ...input(), reason: 'PRIVATE-redaction', clientMutationId: 'redact-1',
    })).comment;
    expect(comment).toMatchObject({ body: '', edits: [], flags: { redacted: true }, tombstone: { reason: 'PRIVATE-redaction' } });
    // A group id is an intentional structural mutation field, unlike sensitive metadata payloads.
    const sensitiveBytes = JSON.stringify(wire).split('PRIVATE-new-group').join('authorized-group-id');
    expect(sensitiveBytes).not.toContain('PRIVATE-');
  });

  it('preserves equivalent-create retry equality while separating actors, modes and logical effects', () => {
    const bound = (input: Record<string, unknown>, owner = actor, crypto = context) => buildReviewCommentCreateEquivalenceCommitmentV1({ context: crypto, actor: owner, input });
    expect(bound(create)).toBe(bound({ ...create, clientMutationId: 'retry', snapshot: { ...create.snapshot, capturedAt: 200 } }));
    expect(bound(create)).not.toBe(bound({ ...create, body: 'changed' }));
    expect(bound(create)).not.toBe(bound(create, { ...actor, userId: 'another-user' }));
    expect(bound(create)).not.toBe(bound(create, actor, { ...context, mode: 'plain', material: null }));
  });

  it('rejects missing material before HTTP and binds content to Account and persisted mode', async () => {
    let requests = 0;
    const comment: ReviewCommentV1 = { v: 1, id: 'comment-1', accountId: context.accountId, workspace,
      anchor: create.anchor, snapshot: create.snapshot, body: create.body, bodyVersion: 1, edits: [], author: actor,
      state: 'open', flags: {}, dispositions: {}, threadId: 'comment-1', transitions: [], createdAt: 1, updatedAt: 1, serverRevision: 1 };
    const split = splitReviewCommentV1(comment);
    const stored: StoredReviewCommentV1 = { v: 1, structural: split.structural,
      sensitiveEnvelope: sealReviewCommentSensitiveEnvelopeV1({ ...split, mode: 'plain' }) };
    const get = (crypto: ReviewCommentTransportContextV1) => executeReviewCommentTransportV1({ actionId: 'reviews.comments.get',
      input: { commentId: comment.id }, context: crypto, actor, randomBytes: (length) => new Uint8Array(length),
      request: async () => { requests++; return { comment: stored }; } });
    await expect(get({ ...context, material: null })).rejects.toMatchObject({ code: 'review_comment_encryption_material_unavailable' });
    expect(requests).toBe(0);
    await expect(get(context)).rejects.toMatchObject({ code: 'review_comment_encryption_mode_mismatch' });
    await expect(get({ ...context, mode: 'plain', material: null })).resolves.toEqual({ comment });
    await expect(get({ ...context, accountId: 'other', mode: 'plain', material: null })).rejects.toMatchObject({ code: 'review_comment_content_binding_mismatch' });
  });
});
