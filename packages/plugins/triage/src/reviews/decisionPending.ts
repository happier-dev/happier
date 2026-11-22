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
// The owner's `needsYou`: a finding waits for the reader's decision, or the reader's verdict is requested.
const needsYouOf = (snapshot: PluginUiResourceProjectionSnapshot<ReviewRead>) =>
  snapshot.value?.human.needsYou.needsYou;

/**
 * Whether a Review entry still waits for the reader (a finding to decide, or a verdict they were asked for), from the
 * Review owner's own `needsYou` fact (the Inbox byline's fact family). Until that read lands a Review is taken to wait, so the
 * agent action draws quiet from first paint rather than filling and then quieting. `false` for any other entry.
 */
export function useReviewWaitsForDecisionV1(
  reviewId: string | undefined,
): boolean {
  const pending = useLivePluginResourceProjection(
    { hostRead: 'review.get', input: { reviewId: reviewId ?? '' } },
    reviewRead,
    needsYouOf,
    { enabled: reviewId !== undefined },
  ).value;
  return reviewId !== undefined && pending !== false;
}
