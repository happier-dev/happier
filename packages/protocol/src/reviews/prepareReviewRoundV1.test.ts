import { describe, expect, it } from 'vitest';

import { preparedReviewTitleV1 } from './prepareReviewRoundV1.js';
import { ReviewStartInputSchema } from './reviewStart.js';
import type { ScmComparisonSource } from '../scm/comparison.js';

const oid = (digit: string) => digit.repeat(40);
const start = (input: Record<string, unknown>) =>
  ReviewStartInputSchema.parse({
    instructions: 'Review it.',
    reviewers: [{ kind: 'engine', engineId: 'codex' }],
    ...input,
  });

describe('preparedReviewTitleV1', () => {
  it.each<[string, ScmComparisonSource, string]>([
    [
      'a commit by its short id',
      { kind: 'commit', commit: oid('3') },
      '3333333',
    ],
    [
      'a detached branch head by its short id',
      { kind: 'branch', head: oid('3'), base: 'main' },
      '3333333',
    ],
    [
      'a named branch by its name',
      { kind: 'branch', head: 'review-topic', base: 'main' },
      'review-topic',
    ],
    [
      'a revision range by its short ids',
      { kind: 'revisionRange', baseOid: oid('1'), headOid: oid('2') },
      '1111111 → 2222222',
    ],
  ])('names %s', (_case, source, title) => {
    expect(
      preparedReviewTitleV1(
        start({ cwd: '/home/alice/work/reviews' }),
        undefined,
        source,
      ),
    ).toBe(title);
  });

  it.each([
    [
      'a POSIX working folder',
      '/tmp/reviews-qa/.dev/worktree/qa5-selected-proposals',
      'qa5-selected-proposals',
    ],
    [
      'a Windows working folder',
      'C:\\Users\\alice\\work\\billing\\',
      'billing',
    ],
  ])(
    'names %s by its folder name, never its absolute path',
    (_case, cwd, title) => {
      expect(preparedReviewTitleV1(start({ cwd, scope: 'repository' }))).toBe(
        title,
      );
    },
  );

  it('names a Session-only Review by the folder its admission resolved', () => {
    expect(
      preparedReviewTitleV1(
        start({ sessionId: 'session', scope: 'repository' }),
        undefined,
        undefined,
        '/home/alice/work/billing',
      ),
    ).toBe('billing');
  });

  it('shortens a head ref that is a full commit id', () => {
    expect(
      preparedReviewTitleV1(
        start({ cwd: '/repo', scope: 'repository', headRef: oid('9') }),
      ),
    ).toBe('9999999');
  });

  it('names a whole-repository Review without any folder in words', () => {
    expect(
      preparedReviewTitleV1(
        start({ sessionId: 'session', scope: 'repository' }),
      ),
    ).toBe('Whole repository');
  });
});
