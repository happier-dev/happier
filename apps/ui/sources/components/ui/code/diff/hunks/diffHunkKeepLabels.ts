import { t } from '@/text';

import type { DiffViewerHunks } from '../diffViewerTypes';

type RowA11y = Readonly<{ n: number; total: number; range: string }>;

/**
 * The words of a change's keep control, everywhere it is drawn (the row, its menu, the phone bar): "Keep" · "Kept"
 * beside Discard, or "Mark reviewed" · "Reviewed" where a change can only be marked (`DiffViewerHunks.keepVerb`).
 */
export function presentDiffHunkKeep(review: Pick<DiffViewerHunks, 'keepVerb'> | undefined, kept: boolean) {
  const marks = review?.keepVerb === 'markReviewed';
  return {
    title: marks ? t(kept ? 'walkthrough.reviewed' : 'walkthrough.markReviewed') : t(kept ? 'hunkReview.kept' : 'hunkReview.keep'),
    accessibilityLabel: (row: RowA11y) => marks
      ? t(kept ? 'hunkReview.unmarkReviewedA11y' : 'hunkReview.markReviewedA11y', row)
      : t(kept ? 'hunkReview.unkeepA11y' : 'hunkReview.keepA11y', row),
  };
}
