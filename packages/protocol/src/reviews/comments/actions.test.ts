import { describe, expect, it } from 'vitest';

import {
  createReviewCommentPrincipalSigningInputV1,
  REVIEW_COMMENT_ACTION_IDS_V1,
  REVIEW_COMMENT_PRINCIPAL_HEADER_V1,
  ReviewCommentActionIdV1Schema,
  ReviewCommentBulkTransitionRequestV1Schema,
  ReviewCommentBulkTransitionResponseV1Schema,
  ReviewCommentListRequestV1Schema,
  ReviewCommentOperationErrorCodeV1Schema,
  ReviewCommentPrincipalHeaderV1Schema,
  stringifyReviewCommentPrincipalCanonicalJsonV1,
} from './actions.js';
import { getActionSpec } from '../../actions/actionSpecs.js';

describe('review comment operation contracts', () => {
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
      grants: [],
    });
  });

  it('accepts machine-installation-signed plugin principal proofs without making grants authoritative', () => {
    const parsed = ReviewCommentPrincipalHeaderV1Schema.parse({
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
    });

    expect(parsed).toEqual({
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
    });
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
