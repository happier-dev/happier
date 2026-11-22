import type { PluginActionResultById } from '@happier-dev/plugin-sdk/actions';
import {
  useLivePluginResourceProjection,
  type PluginUiResourceProjection,
  type PluginUiResourceProjectionSnapshot,
} from '@happier-dev/plugin-ui';

type ReviewRead = PluginActionResultById['review.get'];
const reviewRead: PluginUiResourceProjection<ReviewRead> = {
  // The admitted host Resource is the Review owner's typed read; the summary in the body reads the same one.
  decode: (content) =>
    JSON.parse(new TextDecoder().decode(content.bytes)) as ReviewRead,
};
/**
 * What a Review entry asks of the reader, from the Review owner's own read: no findings leaves nothing to fix (its Fix is
 * not offered at all, T2); otherwise its `needsYou` (a finding to decide, or a verdict they were asked for, the Inbox
 * byline's fact family) puts the decision first; else the fix may lead.
 */
export type TriageReviewEntryWorkV1 = 'nothingToFix' | 'decide' | 'fix';

const workOf = (snapshot: PluginUiResourceProjectionSnapshot<ReviewRead>): TriageReviewEntryWorkV1 | undefined => {
  const read = snapshot.value;
  if (read === undefined) return undefined;
  if (read.review.counts.total === 0) return 'nothingToFix';
  return read.human.needsYou.needsYou ? 'decide' : 'fix';
};

/**
 * The Review entry's work, `null` for any other entry. Until the read lands a Review is taken to wait, so the agent
 * action draws quiet from first paint rather than filling and then quieting.
 */
export function useReviewEntryWorkV1(
  reviewId: string | undefined,
): TriageReviewEntryWorkV1 | null {
  const work = useLivePluginResourceProjection(
    { hostRead: 'review.get', input: { reviewId: reviewId ?? '' } },
    reviewRead,
    workOf,
    { enabled: reviewId !== undefined },
  ).value;
  return reviewId === undefined ? null : work ?? 'decide';
}
