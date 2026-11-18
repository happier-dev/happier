import { describe, expect, it } from 'vitest';
import * as comments from './index.js';
import type { ReviewCommentFingerprintV1 } from './v1.js';
import { projectReviewFindingRoundStatusV1, reviewCommentFindingScopeV1 } from './findingIdentity.js';
import { matchesReviewCommentListFilters } from './queries.js';

type IdentityApi = {
  createReviewFindingIdentityV1: (input: { path?: string; title: string; fingerprint: ReviewCommentFingerprintV1 }) => string;
};

describe('semantic finding identity', () => {
  it('separates observed round appearances from absence proven by complete executable coverage', () => {
    const round = { reviewId: 'review', roundOrdinal: 2, state: 'completed' as const, reviewerIds: ['reviewer'] };
    const finding = { reviewId: 'review', findingIdentity: 'a'.repeat(64),
      appearances: [{ roundOrdinal: 1, runId: 'first', reviewerId: 'reviewer' }] };
    const current = { roundOrdinal: 2, runId: 'second', reviewerId: 'reviewer' };
    expect(projectReviewFindingRoundStatusV1(finding, round)).toBe('looks_addressed');
    expect(projectReviewFindingRoundStatusV1({ ...finding, appearances: [...finding.appearances, current] }, round)).toBe('still_there');
    expect(projectReviewFindingRoundStatusV1({ ...finding, appearances: [current] }, round)).toBe('new');
    for (const state of ['running', 'partial', 'failed', 'cancelled'] as const) {
      expect(projectReviewFindingRoundStatusV1(finding, { ...round, state })).toBe('unknown');
    }
    expect(projectReviewFindingRoundStatusV1(finding, { ...round, reviewerIds: [] })).toBe('unknown');
    expect(projectReviewFindingRoundStatusV1({ ...finding, appearances: undefined }, round)).toBe('unknown');
    expect(projectReviewFindingRoundStatusV1({ ...finding, appearances: [{ ...current, roundOrdinal: 3 }] }, round)).toBe('unknown');
    expect(projectReviewFindingRoundStatusV1({ ...finding, reviewId: 'other-review' }, round)).toBeNull();
    expect(projectReviewFindingRoundStatusV1({ ...finding, parentCommentId: 'root' }, round)).toBeNull();
  });
  it('finds the canonical decision through a qualified later run appearance', () => {
    const root = { id: 'finding', reviewId: 'review-1', workspace: { machineId: 'machine-1', path: '/repo' },
      sessionId: 'session-1', runId: 'run-1', engineId: 'codex', state: 'dismissed' as const,
      flags: {}, anchor: { kind: 'file' as const, filePath: 'a.ts' }, author: { kind: 'user' as const, userId: 'user-1' },
      updatedAt: 1, serverRevision: 2, appearances: [{ roundOrdinal: 2, runId: 'run-2', reviewerId: 'claude', machineId: 'machine-2', sessionId: 'session-2' }] };
    const filters = { runId: 'run-2', sessionId: 'session-2', engineId: 'claude', states: [], includeHistory: true, limit: 50 };
    expect(matchesReviewCommentListFilters(root, filters)).toBe(true);
    expect(matchesReviewCommentListFilters(root, { ...filters, sessionId: 'another-session' })).toBe(false);
    expect(matchesReviewCommentListFilters(root, { ...filters, roundOrdinal: 1 })).toBe(false);
    expect(matchesReviewCommentListFilters({ ...root, reviewId: undefined }, filters)).toBe(false);
  });
  it('partitions bound findings only by Review while keeping private unbound scope', () => {
    const finding = { findingIdentity: 'a'.repeat(64), reviewId: 'review-1',
      projectId: 'project-1', workspace: { machineId: 'machine-1', path: '/repo' }, sessionId: 'session-1' };
    expect(reviewCommentFindingScopeV1(finding)).toEqual(['review', 'review-1', finding.findingIdentity]);
    expect(reviewCommentFindingScopeV1({ ...finding, workspace: { machineId: 'machine-2', path: '/worktree' }, sessionId: 'session-2' }))
      .toEqual(reviewCommentFindingScopeV1(finding));
    expect(reviewCommentFindingScopeV1({ ...finding, reviewId: 'review-2' })).not.toEqual(reviewCommentFindingScopeV1(finding));
    const { reviewId: _reviewId, ...unbound } = finding;
    expect(reviewCommentFindingScopeV1(unbound)).toEqual([['workspace', 'machine-1', '/repo'], finding.findingIdentity, 'session-1']);
    expect(reviewCommentFindingScopeV1({ ...finding, parentCommentId: 'root' })).toBeNull();
  });
  it('keeps one identity across lines, engines and changed file contents', () => {
    const api = comments as typeof comments & Partial<IdentityApi>;
    expect(typeof api.createReviewFindingIdentityV1).toBe('function');
    if (!api.createReviewFindingIdentityV1) return;
    const fingerprint = { normalizedMessageHash: 'message', fileSha: 'before', engineId: 'engine-a', lineRange: { startLine: 2, endLine: 3 } };
    const identity = api.createReviewFindingIdentityV1({ path: 'src/a.ts', title: 'Null check', fingerprint });
    const changed = { ...fingerprint, fileSha: 'after', engineId: 'engine-b', lineRange: { startLine: 20, endLine: 21 } };
    expect(api.createReviewFindingIdentityV1({ path: 'src/a.ts', title: '  NULL   check ', fingerprint: changed })).toBe(identity);
    expect(changed.fileSha).not.toBe(fingerprint.fileSha);
    expect(api.createReviewFindingIdentityV1({ path: 'src/b.ts', title: 'Null check', fingerprint })).not.toBe(identity);
    expect(api.createReviewFindingIdentityV1({ path: 'src/a.ts', title: 'Null check', fingerprint: { ...fingerprint, normalizedMessageHash: 'different' } })).not.toBe(identity);
  });

  it('uses rule identity ahead of the reviewer title and normalizes path separators', () => {
    const api = comments as typeof comments & Partial<IdentityApi>;
    expect(typeof api.createReviewFindingIdentityV1).toBe('function');
    if (!api.createReviewFindingIdentityV1) return;
    const fingerprint = { ruleId: 'null-check', normalizedMessageHash: 'message' };
    expect(api.createReviewFindingIdentityV1({ path: 'src\\a.ts', title: 'First title', fingerprint }))
      .toBe(api.createReviewFindingIdentityV1({ path: './src/a.ts', title: 'Other title', fingerprint }));
  });
});
