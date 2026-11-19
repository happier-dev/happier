import type { ReviewArtifactV1 } from '@happier-dev/protocol/reviews/reviewArtifactV1';
import type { ReviewListItemV1 } from '@happier-dev/protocol/reviews/reviewListV1';
import { t } from '@/text';
import type { ReviewDetailGlance } from './ReviewDetailView';

/** The verdict sentence from the Review owner's counts; running and failed rounds say so instead. */
export function projectReviewGlance(round: ReviewArtifactV1['rounds'][number] | undefined, review: ReviewListItemV1 | null): ReviewDetailGlance | null {
  const state = round?.state ?? review?.state;
  if (!state) return null;
  if (state === 'running') return { sentence: t('reviewWalkthrough.detail.glanceRunning'), tone: 'quiet', facts: [] };
  if (state === 'failed') return { sentence: t('reviewWalkthrough.detail.glanceFailed'), tone: 'failed', facts: [] };
  if (!review) return round?.summary ? { sentence: round.summary, tone: 'quiet', facts: [] } : null;
  const { total, needsDecision } = review.counts;
  const facts = round?.summary ? [round.summary] : [];
  if (total === 0) return { sentence: t('reviewWalkthrough.detail.glanceNoFindings'), tone: 'quiet', facts };
  if (needsDecision > 0) return { sentence: t('reviewWalkthrough.detail.glanceToDecide', { count: needsDecision }), tone: 'attention',
    facts: [t('reviewWalkthrough.detail.findingsCount', { count: total }), ...facts] };
  return { sentence: t('reviewWalkthrough.detail.glanceAllDecided'), tone: 'quiet', facts: [t('reviewWalkthrough.detail.findingsCount', { count: total }), ...facts] };
}
