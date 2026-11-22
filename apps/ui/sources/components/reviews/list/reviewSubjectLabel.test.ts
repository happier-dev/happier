import { expect, it } from 'vitest';
import { t } from '@/text';
import { reviewSubjectFact } from './reviewSubjectLabel';

it('names a branch Review by its comparison, with the head sha short and the fact in mono (U8 R5 L1)', () => {
  expect(reviewSubjectFact('comparison', { kind: 'branch', head: `04996b5${'a'.repeat(33)}`, base: 'main' }))
    .toEqual({ text: t('scmComparison.scope.branch', { head: '04996b5', base: 'main' }), mono: true });
  expect(reviewSubjectFact('comparison', { kind: 'branch', head: 'feature/retry', base: 'main' }))
    .toEqual({ text: t('scmComparison.scope.branch', { head: 'feature/retry', base: 'main' }), mono: true });
  // Working-tree and Session comparisons keep the subject word; so does a Review whose round recorded no comparison.
  expect(reviewSubjectFact('comparison', { kind: 'workingTree' })).toEqual({ text: t('reviewWalkthrough.collection.subjectComparison'), mono: false });
  expect(reviewSubjectFact('repository', undefined)).toEqual({ text: t('reviewWalkthrough.collection.subjectRepository'), mono: false });
});
