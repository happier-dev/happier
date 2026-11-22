import type { ReviewSubjectKindV1 } from '@happier-dev/protocol/reviews/reviewArtifactV1';
import type { ScmComparisonSource } from '@happier-dev/protocol/scm/comparison';

import { resolveSessionScmReviewComparisonLabel } from '@/components/sessions/panes/details/sessionDetailsTabBuilders';
import { formatCodeCommitShortOid } from '@/components/projects/files/code/codeEntryHistoryPresentation';
import { t } from '@/text';

export function reviewSubjectLabel(kind: ReviewSubjectKindV1): string {
  return t(
    kind === 'pull_request'
      ? 'reviewWalkthrough.collection.subjectPullRequest'
      : kind === 'repository'
        ? 'reviewWalkthrough.collection.subjectRepository'
        : 'reviewWalkthrough.collection.subjectComparison',
  );
}

const FULL_OID = /^[0-9a-f]{40,64}$/i;

/**
 * What a Review read, as its page's facts line says it: a branch, commit or revision-range comparison by its refs
 * ("04996b5 vs main", in the code face, a full sha shortened), through the comparison label owner; anything else
 * (a working tree, a Session, the whole repository, a pull request) by its subject word.
 */
export function reviewSubjectFact(kind: ReviewSubjectKindV1, source: ScmComparisonSource | undefined): Readonly<{ text: string; mono: boolean }> {
  if (kind === 'comparison' && source && (source.kind === 'branch' || source.kind === 'commit' || source.kind === 'revisionRange')) {
    const named = source.kind === 'branch' && FULL_OID.test(source.head) ? { ...source, head: formatCodeCommitShortOid(source.head) } : source;
    return { text: resolveSessionScmReviewComparisonLabel(named), mono: true };
  }
  return { text: reviewSubjectLabel(kind), mono: false };
}
