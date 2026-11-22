import { expect, it } from 'vitest';
import { buildReviewCommentFixture } from '@/dev/testkit/fixtures/reviewComments';
import { filterReviewChangesComments } from './reviewChangesComments';

it('narrows the opened round to the chosen reviewer while All includes personal gutter comments and repeated findings', () => {
  const claude = buildReviewCommentFixture({ id: 'claude', roundOrdinal: 2, engineId: 'claude' });
  const codex = buildReviewCommentFixture({ id: 'codex', roundOrdinal: 2, engineId: 'codex' });
  const previous = buildReviewCommentFixture({ id: 'previous', roundOrdinal: 1, engineId: 'claude' });
  const repeated = buildReviewCommentFixture({ id: 'repeated', roundOrdinal: 1, engineId: 'codex',
    appearances: [{ roundOrdinal: 2, runId: 'run-2', reviewerId: 'step-2-reviewer-1' }] });
  const personal = buildReviewCommentFixture({ id: 'personal', roundOrdinal: 2 });
  const comments = [claude, codex, previous, repeated, personal];
  expect(filterReviewChangesComments(comments, { roundOrdinal: 2, reviewerId: null })).toEqual([claude, codex, repeated, personal]);
  expect(filterReviewChangesComments(comments, { roundOrdinal: 2, reviewerId: 'claude' })).toEqual([claude]);
  expect(filterReviewChangesComments(comments, { roundOrdinal: 2, reviewerId: 'codex' })).toEqual([codex, repeated]);
  expect(filterReviewChangesComments(comments, { roundOrdinal: 1, reviewerId: 'claude' })).toEqual([previous]);
});
