import { describe, expect, it } from 'vitest';

import {
  createReviewCommentPrincipalSigningInputV1,
  REVIEW_COMMENT_ACTION_IDS_V1,
  REVIEW_COMMENT_PRINCIPAL_HEADER_V1,
  ReviewCommentActionIdV1Schema,
  ReviewCommentActionInputSchemasV1,
  ReviewCommentBulkTransitionRequestV1Schema,
  ReviewCommentBulkTransitionResponseV1Schema,
  ReviewCommentCreateResponseV1Schema,
  ReviewCommentListRequestV1Schema,
  ReviewCommentOperationErrorCodeV1Schema,
  ReviewCommentPrincipalHeaderV1Schema,
  stringifyReviewCommentPrincipalCanonicalJsonV1,
} from './actions.js';
import { getActionSpec } from '../../actions/actionSpecs.js';

describe('review comment operation contracts', () => {
  it('bounds create mutation identity to the cross-provider storage contract', () => {
    const base = {
      projectId: 'project-1',
      anchor: { kind: 'file' as const, filePath: 'src/example.ts' },
      snapshot: {
        kind: 'binary' as const,
        sizeBytes: 1,
        sha256: 'hash',
        source: 'workingTree' as const,
        capturedAt: 1,
      },
      body: 'Review body',
    };

    expect(ReviewCommentActionInputSchemasV1['reviews.comments.create'].safeParse({
      ...base,
      clientMutationId: 'm'.repeat(191),
    }).success).toBe(true);
    expect(ReviewCommentActionInputSchemasV1['reviews.comments.create'].safeParse({
      ...base,
      clientMutationId: 'm'.repeat(192),
    }).success).toBe(false);
  });

  it('publishes a truthful create replay flag and stable idempotency conflict code', () => {
    expect(ReviewCommentCreateResponseV1Schema.shape.replayed.parse(true)).toBe(true);
    expect(ReviewCommentOperationErrorCodeV1Schema.parse('review_comment_idempotency_conflict'))
      .toBe('review_comment_idempotency_conflict');
  });

  it('publishes stable action ids without registering a parallel review-engine family', () => {
    expect(REVIEW_COMMENT_ACTION_IDS_V1).toEqual([
      'reviews.comments.create',
      'reviews.comments.list',
      'reviews.comments.get',
      'reviews.comments.transition',
      'reviews.comments.edit',
      'reviews.comments.reply',
      'reviews.comments.redact',
      'reviews.comments.setDisposition',
      'reviews.comments.attachEvidence',
      'reviews.comments.bulkTransition',
    ]);

    for (const actionId of REVIEW_COMMENT_ACTION_IDS_V1) {
      expect(ReviewCommentActionIdV1Schema.parse(actionId)).toBe(actionId);
    }
  });

  it('filters comment lists by workspace project session run history author file folder severity and taxonomy targets', () => {
    const parsed = ReviewCommentListRequestV1Schema.parse({
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      sessionId: 'session-1',
      runId: 'run-1',
      states: ['proposed', 'open'],
      authorKind: 'plugin',
      authorId: 'review-coderabbit',
      engineId: 'review-coderabbit',
      filePath: 'src/index.ts',
      folderPath: 'src/security',
      severity: 'critical',
      taxonomyIds: ['security.open_redirect', 'cwe.601'],
      includeHistory: true,
      cursor: 'cursor-1',
      limit: 100,
    });

    expect(parsed.sessionId).toBe('session-1');
    expect(parsed.folderPath).toBe('src/security');
    expect(parsed.severity).toBe('critical');
    expect(parsed.taxonomyIds).toEqual(['security.open_redirect', 'cwe.601']);
    expect(parsed.states).toEqual(['proposed', 'open']);
    expect(parsed.limit).toBe(100);
  });

  it('publishes the host-stamped review-comment principal header contract', () => {
    expect(REVIEW_COMMENT_PRINCIPAL_HEADER_V1).toBe('x-happier-review-comment-principal');

    expect(ReviewCommentPrincipalHeaderV1Schema.parse({
      actor: { kind: 'plugin', pluginId: 'review-coderabbit' },
    })).toEqual({
      actor: { kind: 'plugin', pluginId: 'review-coderabbit' },
    });
  });

  it('rejects obsolete client-claimed grants from machine-signed principal headers', () => {
    expect(() => ReviewCommentPrincipalHeaderV1Schema.parse({
      actor: { kind: 'plugin', pluginId: 'review-coderabbit' },
      grants: ['reviews.comments.write.direct'],
      proof: {
        v: 1,
        alg: 'ed25519-machine-installation-v1',
        machineId: 'machine-1',
        installationId: 'installation-1',
        issuedAt: 1710000000000,
        nonce: 'nonce-1',
        method: 'POST',
        path: '/v1/reviews/comments',
        bodySha256Base64Url: 'body-hash-1',
        signatureBase64Url: 'sig-1',
      },
    })).toThrow();
  });

  it('builds stable plugin principal signing input from actor and request-bound proof metadata only', () => {
    const input = new TextDecoder().decode(createReviewCommentPrincipalSigningInputV1({
      actor: { kind: 'plugin', pluginId: 'review-coderabbit' },
      proof: {
        v: 1,
        alg: 'ed25519-machine-installation-v1',
        machineId: 'machine-1',
        installationId: 'installation-1',
        issuedAt: 1710000000000,
        nonce: 'nonce-1',
        method: 'POST',
        path: '/v1/reviews/comments',
        bodySha256Base64Url: 'body-hash-1',
      },
    }));

    expect(input).toBe(
      'happier.reviewCommentPrincipal.v1\u0000{"actor":{"kind":"plugin","pluginId":"review-coderabbit"},"proof":{"alg":"ed25519-machine-installation-v1","bodySha256Base64Url":"body-hash-1","installationId":"installation-1","issuedAt":1710000000000,"machineId":"machine-1","method":"POST","nonce":"nonce-1","path":"/v1/reviews/comments","v":1}}',
    );
  });

  it('binds exact execution-run current intent into the machine-signed principal', () => {
    const currentIntent = {
      v: 1 as const,
      kind: 'execution_run_host_action' as const,
      actionId: 'reviews.comments.create' as const,
      subjectFingerprint: 'a'.repeat(64),
      effectBodySha256Base64Url: 'b'.repeat(43),
      sessionId: 'session-1',
      runId: 'run-1',
      callId: 'call-1',
      profileId: 'acme.review/review',
      pluginId: 'acme.review',
      agentId: 'claude',
      projectId: 'project-1',
      workspaceId: 'workspace-1',
      immutableGenerationId: 'generation-1',
      packageDigest: `sha256:${'c'.repeat(64)}`,
      manifestDigest: `sha256:${'d'.repeat(64)}`,
    };
    const parsed = ReviewCommentPrincipalHeaderV1Schema.parse({
      actor: { kind: 'agent', agentId: 'claude', sessionId: 'session-1' },
      currentIntent,
    });

    expect(parsed.currentIntent).toEqual(currentIntent);
    const input = new TextDecoder().decode(createReviewCommentPrincipalSigningInputV1({
      actor: parsed.actor,
      currentIntent: parsed.currentIntent,
      proof: {
        v: 1,
        alg: 'ed25519-machine-installation-v1',
        machineId: 'machine-1',
        installationId: 'installation-1',
        issuedAt: 1710000000000,
        nonce: 'nonce-1',
        method: 'POST',
        path: '/v1/reviews/comments',
        bodySha256Base64Url: currentIntent.effectBodySha256Base64Url,
      },
    }));
    expect(input).toContain(`\"currentIntent\":${stringifyReviewCommentPrincipalCanonicalJsonV1(currentIntent)}`);
    expect(() => ReviewCommentPrincipalHeaderV1Schema.parse({
      actor: parsed.actor,
      currentIntent: { ...currentIntent, extraAuthority: true },
    })).toThrow();
  });

  it('canonicalizes principal request bodies with stable object key ordering', () => {
    expect(stringifyReviewCommentPrincipalCanonicalJsonV1({
      z: [{ b: 2, a: 1 }],
      a: 'first',
      omitted: undefined,
    })).toBe('{"a":"first","z":[{"a":1,"b":2}]}');
  });

  it('requires explicit evidence for bulk resolution and exposes stable error codes', () => {
    expect(() => ReviewCommentBulkTransitionRequestV1Schema.parse({
      commentIds: ['comment-1'],
      toState: 'resolved',
      clientMutationId: 'mutation-1',
    })).toThrow();

    const parsed = ReviewCommentBulkTransitionRequestV1Schema.parse({
      commentIds: ['comment-1'],
      toState: 'resolved',
      expectedState: 'open',
      evidence: [{ kind: 'reasoning', message: 'Fixed by follow-up commit.' }],
      bulkActionId: 'bulk-1',
      clientMutationId: 'mutation-1',
    });
    expect(parsed.toState).toBe('resolved');
    expect(parsed.expectedState).toBe('open');
    expect(parsed.bulkActionId).toBe('bulk-1');

    const response = ReviewCommentBulkTransitionResponseV1Schema.parse({
      bulkActionId: 'bulk-1',
      updated: [],
      failed: [{
        commentId: 'comment-stale',
        errorCode: 'review_comment_conflict',
        error: 'Review comment state did not match expectedState',
      }],
    });
    expect(response.failed).toEqual([{
      commentId: 'comment-stale',
      errorCode: 'review_comment_conflict',
      error: 'Review comment state did not match expectedState',
    }]);

    expect(ReviewCommentOperationErrorCodeV1Schema.parse('review_comment_direct_write_permission_required'))
      .toBe('review_comment_direct_write_permission_required');
    expect(ReviewCommentOperationErrorCodeV1Schema.parse('review_comment_encryption_mode_mismatch'))
      .toBe('review_comment_encryption_mode_mismatch');
    expect(ReviewCommentOperationErrorCodeV1Schema.parse('review_comment_already_redacted'))
      .toBe('review_comment_already_redacted');
  });

  it('registers every review comment action as a canonical ActionSpec entry', () => {
    for (const actionId of REVIEW_COMMENT_ACTION_IDS_V1) {
      const spec = getActionSpec(actionId);
      expect(spec.id).toBe(actionId);
      expect(spec.bindings?.rpcMethod).toBe(actionId);
      expect(spec.surfaces.rpc).toBe(true);
    }
  });
});
