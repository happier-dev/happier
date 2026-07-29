import { t } from '@/text';
import type {
    UsageAnalyticsViewModel,
    UsageCacheSavingsViewModel,
    UsageFilterState,
} from '@/sync/api/account/usageAnalytics';
import { formatTokenCount } from '@/utils/format/usageNumbers';

import {
    buildUsageRecapCardModels,
    type UsageRecapCardAccentTone,
    type UsageRecapCardId,
    type UsageRecapCardModel,
    type UsageRecapCardVisualModel,
} from '../../buildUsageRecapCardModels';

/**
 * Story-mode slide models. Reuses the canonical recap card models
 * (`buildUsageRecapCardModels`) for the four classic cards and appends the
 * cache-savings slide when the period actually saved cached tokens — story
 * order per the L6 IA: period total → peak/streak → top model → cache → rhythm.
 */

export type RecapStorySlideId = UsageRecapCardId | 'cache';

export type RecapStorySlide = Readonly<{
    id: RecapStorySlideId;
    label: string;
    value: string;
    subtitle: string;
    accentTone: UsageRecapCardAccentTone;
    /** Numeric slides animate their value with the odometer. */
    numericValue: number | null;
    visual: UsageRecapCardVisualModel | null;
}>;

function toSlide(card: UsageRecapCardModel, numericValue: number | null): RecapStorySlide {
    return {
        id: card.id,
        label: card.label,
        value: card.value,
        subtitle: card.subtitle,
        accentTone: card.accentTone,
        numericValue,
        visual: card.visual,
    };
}

export function buildRecapStorySlides(input: Readonly<{
    viewModel: UsageAnalyticsViewModel;
    filters: UsageFilterState;
    cacheSavings: UsageCacheSavingsViewModel | null;
}>): RecapStorySlide[] {
    const cards = buildUsageRecapCardModels({ viewModel: input.viewModel, filters: input.filters });
    if (cards.length === 0) {
        return [];
    }

    const byId = new Map(cards.map((card) => [card.id, card]));
    const slides: RecapStorySlide[] = [];

    const usage = byId.get('usage');
    if (usage) {
        slides.push(toSlide(usage, input.filters.metric === 'cost'
            ? input.viewModel.overview.totalCost
            : input.viewModel.overview.totalTokens));
    }
    const streak = byId.get('streak');
    if (streak) {
        slides.push(toSlide(streak, input.viewModel.insights.currentStreakDays));
    }
    const model = byId.get('model');
    if (model) {
        slides.push(toSlide(model, null));
    }
    if (input.cacheSavings && input.cacheSavings.cachedReadTokens > 0) {
        slides.push({
            id: 'cache',
            label: t('usage.cacheSavings'),
            value: formatTokenCount(input.cacheSavings.cachedReadTokens),
            subtitle: t('usage.tokens'),
            accentTone: 'orange',
            numericValue: input.cacheSavings.cachedReadTokens,
            visual: null,
        });
    }
    const rhythm = byId.get('rhythm');
    if (rhythm) {
        slides.push(toSlide(rhythm, null));
    }

    return slides;
}
