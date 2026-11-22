import type { PluginActionResultById } from '@happier-dev/plugin-sdk/actions';
import { pluginJsonValuesEqual } from '@happier-dev/plugin-sdk/protocol';
import type { ReviewPrRoundQualityV1 } from '@happier-dev/protocol/reviews/reviewQualityPresentationV1';
import type { ReviewPublicationWalkthroughStopV1 } from '@happier-dev/protocol/reviews/comments/actions';

import type { PluginUiResourceProjection } from './resourceStore.js';

type RoundWalkthrough = Readonly<{ roundOrdinal: number; stops: readonly ReviewPublicationWalkthroughStopV1[] }>;
type ReviewDetailResource = PluginActionResultById['review.get'] & Readonly<{
  roundQuality?: ReviewPrRoundQualityV1;
  roundWalkthrough?: RoundWalkthrough;
}>;

export const reviewDetailProjection: PluginUiResourceProjection<ReviewDetailResource> = {
  decode(content, previous) {
    // The admitted host owns these bytes and projects only scores from encrypted content.
    const next = JSON.parse(new TextDecoder().decode(content.bytes)) as ReviewDetailResource;
    if (previous && pluginJsonValuesEqual(previous, next)) return previous;
    return previous ? {
      ...next,
      roundQuality: pluginJsonValuesEqual(previous.roundQuality, next.roundQuality) ? previous.roundQuality : next.roundQuality,
      roundWalkthrough: pluginJsonValuesEqual(previous.roundWalkthrough, next.roundWalkthrough) ? previous.roundWalkthrough : next.roundWalkthrough,
    } : next;
  },
};
