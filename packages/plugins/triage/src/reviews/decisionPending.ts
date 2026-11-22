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
const pendingOf = (snapshot: PluginUiResourceProjectionSnapshot<ReviewRead>) =>
  snapshot.value?.human.needsYou.pendingDecisions;

/**
 * Whether a Review entry still waits for the reader to decide its findings, from the Review owner's own
 * `pendingDecisions` fact (the Inbox byline's fact family). Until that read lands a Review is taken to wait, so the
 * agent action draws quiet from first paint rather than filling and then quieting. `false` for any other entry.
 */
export function useReviewWaitsForDecisionV1(
  reviewId: string | undefined,
): boolean {
  const pending = useLivePluginResourceProjection(
    { hostRead: 'review.get', input: { reviewId: reviewId ?? '' } },
    reviewRead,
    pendingOf,
    { enabled: reviewId !== undefined },
  ).value;
  return reviewId !== undefined && pending !== false;
}
