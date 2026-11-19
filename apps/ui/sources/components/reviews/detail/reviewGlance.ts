import type { ReviewArtifactV1 } from '@happier-dev/protocol/reviews/reviewArtifactV1';
import type { ReviewListItemV1 } from '@happier-dev/protocol/reviews/reviewListV1';
import { projectHappierReviewGlance } from '@happier-dev/plugin-ui/components';
import { t } from '@/text';
import type { ReviewDetailGlance } from './ReviewDetailView';

/** The verdict sentence from the Review owner's counts; running and failed rounds say so instead. */
export function projectReviewGlance(round: ReviewArtifactV1['rounds'][number] | undefined, review: ReviewListItemV1 | null): ReviewDetailGlance | null {
  return projectHappierReviewGlance(round, review, {
    running: t('reviewWalkthrough.detail.glanceRunning'), failed: t('reviewWalkthrough.detail.glanceFailed'),
    noFindings: t('reviewWalkthrough.detail.glanceNoFindings'), allDecided: t('reviewWalkthrough.detail.glanceAllDecided'),
    toDecide: count => t('reviewWalkthrough.detail.glanceToDecide', { count }),
    findingsCount: count => t('reviewWalkthrough.detail.findingsCount', { count }),
  });
}
