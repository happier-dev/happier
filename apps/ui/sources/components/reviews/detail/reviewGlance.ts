import type { ReviewArtifactV1 } from '@happier-dev/protocol/reviews/reviewArtifactV1';
import type { ReviewListItemV1 } from '@happier-dev/protocol/reviews/reviewListV1';
import { joinHappierFacts } from '@happier-dev/plugin-ui/presentation';
import { projectHappierReviewGlance } from '@happier-dev/plugin-ui/components';
import { t } from '@/text';
import type { ReviewDetailGlance } from './ReviewDetailView';

/**
 * The verdict sentence from the Review owner's counts; running and failed rounds say so instead. On the Review page
 * (`countsOnChips`) the finding counts live on the filter chips, so the facts line carries only the round's own summary.
 * Fixed findings close the sentence ("2 findings to decide · 1 fixed", lab `detail-fixed`).
 */
export function projectReviewGlance(round: ReviewArtifactV1['rounds'][number] | undefined, review: ReviewListItemV1 | null,
  options?: Readonly<{ countsOnChips?: boolean; fixedCount?: number }>): ReviewDetailGlance | null {
  const glance = projectHappierReviewGlance(round, review, {
    running: t('reviewWalkthrough.detail.glanceRunning'), failed: t('reviewWalkthrough.detail.glanceFailed'),
    noFindings: t('reviewWalkthrough.detail.glanceNoFindings'), allDecided: t('reviewWalkthrough.detail.glanceAllDecided'),
    toDecide: count => t('reviewWalkthrough.detail.glanceToDecide', { count }),
    ...(options?.countsOnChips ? {} : { findingsCount: (count: number) => t('reviewWalkthrough.detail.findingsCount', { count }) }),
  });
  const fixed = options?.fixedCount ?? 0;
  return glance && fixed > 0
    ? { ...glance, sentence: joinHappierFacts(glance.sentence, t('reviewWalkthrough.detail.fixedCount', { count: fixed })) }
    : glance;
}
