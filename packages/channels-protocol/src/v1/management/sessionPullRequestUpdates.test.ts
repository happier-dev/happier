import { describe, expect, it } from 'vitest';
import { SessionPullRequestUpdateV1Schema } from '../index.js';

const update = {
  v: 1, bindingId: 'binding-1', sessionId: 'session-1',
  pullRequest: { repository: 'acme/widgets', number: 5 }, head: { sha: 'head-1', ref: 'fix/widgets' },
  events: [
    { kind: 'comment', id: '11', revision: 't1', occurredAt: 1,
      author: { kind: 'person', principalId: '99', label: 'Ada' },
      url: 'https://github.com/acme/widgets/pull/5#issuecomment-11', body: 'Keep the complete comment.' },
    { kind: 'inlineComment', id: '12', revision: 't2', occurredAt: 1,
      author: { kind: 'person', principalId: '88' }, body: 'Keep the anchor too.',
      reviewId: '13', path: 'src/example.ts', line: 4, diffHunk: '@@ -1 +1 @@\n-old\n+new' },
    { kind: 'review', id: '13', revision: 't3', occurredAt: 2,
      author: { kind: 'person', principalId: '88' }, body: 'Please revise.',
      verdict: 'changesRequested', inlineCommentIds: ['12'] },
  ],
} as const;

describe('Session pull-request update envelope', () => {
  it('preserves distinct full feedback and native identities through the public strict reader', () => {
    expect(SessionPullRequestUpdateV1Schema.parse(update)).toEqual(update);
    const continuation = { firstOccurrenceId: 'github:comment:11:t1', hasMore: true };
    expect(SessionPullRequestUpdateV1Schema.parse({ ...update, continuation })).toEqual({ ...update, continuation });
    expect(SessionPullRequestUpdateV1Schema.safeParse({ ...update, continuation: { ...continuation, hasMore: 'yes' } }).success).toBe(false);
    expect(SessionPullRequestUpdateV1Schema.safeParse({ ...update, events: [] }).success).toBe(false);
    expect(SessionPullRequestUpdateV1Schema.safeParse({ ...update, policy: { mode: 'autoFix' } }).success).toBe(false);
    expect(SessionPullRequestUpdateV1Schema.safeParse({ ...update, events: [{ ...update.events[0], approve: true }] }).success).toBe(false);
  });

  it('preserves an explicitly measured fork head repository without guessing a missing owner', () => {
    const repository = { kind: 'github', deployment: 'https://github.com', repository: 'contributor/widgets' };
    expect(SessionPullRequestUpdateV1Schema.parse({ ...update, head: { ...update.head, repository } }).head)
      .toEqual({ ...update.head, repository });
    expect(SessionPullRequestUpdateV1Schema.parse(update).head).toEqual(update.head);
    expect(SessionPullRequestUpdateV1Schema.safeParse({ ...update, head: { ...update.head, repository: 'not a repository' } }).success).toBe(false);
  });

  it('requires exact failure evidence or an explicit unavailable result and carries status-only pushes', () => {
    const author = { kind: 'process', principalId: '99' } as const;
    const failed = { kind: 'check', id: 'check-run:21', logicalCheckId: 'check-run:21', revision: 'attempt-2',
      occurredAt: 3, author, state: 'failed', name: 'Tests',
      failure: { kind: 'unavailable', reason: 'nativeSelectionUnavailable' } } as const;
    expect(SessionPullRequestUpdateV1Schema.safeParse({ ...update, events: [failed] }).success).toBe(true);
    const { failure: _failure, ...withoutEvidence } = failed;
    expect(SessionPullRequestUpdateV1Schema.safeParse({ ...update, events: [withoutEvidence] }).success).toBe(false);
    expect(SessionPullRequestUpdateV1Schema.safeParse({ ...update, events: [{ ...failed,
      failure: { kind: 'summary', summary: { jobs: [] } } }] }).success).toBe(false);
    expect(SessionPullRequestUpdateV1Schema.parse({ ...update, events: [{ kind: 'push', id: 'push-1',
      revision: 'head-2', occurredAt: 4, author: { kind: 'unknown', principalId: null },
      sha: 'head-2', ref: 'fix/widgets', writer: 'unknown' }] }).events[0]).toMatchObject({ writer: 'unknown' });
  });
});
