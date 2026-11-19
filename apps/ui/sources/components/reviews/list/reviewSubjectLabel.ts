import type { ReviewSubjectKindV1 } from '@happier-dev/protocol/reviews/reviewArtifactV1';

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
