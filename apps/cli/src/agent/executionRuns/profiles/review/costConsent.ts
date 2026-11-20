import type { ReviewEngineListItem } from '@happier-dev/protocol/reviews/reviewEngines';
import type { PluginExecutionRunProfileContributionV2 } from '@happier-dev/protocol';

/** The selected profile owns the option and wording for one paid start. */
export function readReviewProfileCostConsent(profile: Pick<PluginExecutionRunProfileContributionV2, 'metadata' | 'optionsSchema'> | null): ReviewEngineListItem['costConsent'] {
  const optionKey = typeof profile?.metadata?.reviewCostConsentOption === 'string' ? profile.metadata.reviewCostConsentOption.trim() : '';
  const option = profile?.optionsSchema?.properties?.[optionKey];
  const title = typeof option?.title === 'string' ? option.title.trim() : '';
  const description = typeof option?.description === 'string' ? option.description.trim() : '';
  return option?.type === 'boolean' && title ? { optionKey, title, ...(description ? { description } : {}) } : undefined;
}
