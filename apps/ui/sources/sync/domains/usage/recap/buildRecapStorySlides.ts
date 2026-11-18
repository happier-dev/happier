import { compareUsageMeasurementsDescending } from '@happier-dev/protocol/usage/usageAggregation';
import { formatUsageChartClock, formatUsageDurationCompact, formatUsageUtcOffset } from '@happier-dev/protocol/usage/usageFormatting';
import type { UsageRecapComposed } from '@happier-dev/protocol/usage/usageRecap';
import { getPreferredLanguage, t } from '@/text';
import type { UsageCacheSavingsViewModel } from '@/sync/api/account/usageAnalytics';
import { formatTokenCount, formatTokenCountLong } from '@/utils/format/usageNumbers';

import {
    buildUsageRecapCardModels,
    type UsageRecapCardId,
    type UsageRecapCardModel,
    type UsageRecapCardVisualModel,
} from './buildUsageRecapCardModels';
import { usageAgentTitle } from '../usageLabels';

/**
 * Story-mode slide models. Reuses the canonical recap card models
 * (`buildUsageRecapCardModels`) for the four classic cards and appends the
 * cache-savings slide when measured. The private recap composition supplies
 * additional witnessed facts for the same shown query.
 */

export type RecapStorySlideId = UsageRecapCardId | 'cache' | 'agentMix' | 'work' | 'night' | 'parallel' | 'coach';

export type RecapStorySlide = Readonly<{
    id: RecapStorySlideId;
    label: string;
    value: string;
    subtitle: string;
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
        numericValue,
        visual: card.visual,
    };
}

function toCountSlide(id: RecapStorySlideId, label: string, count: number, subtitle = ''): RecapStorySlide {
    return { id, label, value: formatTokenCountLong(count), subtitle, numericValue: count, visual: null };
}

function appendComposedSlides(slides: RecapStorySlide[], recap: UsageRecapComposed): void {
    const { agentMix, work, night, parallel, coach } = recap.facts;
    if (agentMix?.some(row => row.tokens !== null && row.tokens > 0)) {
        const rows = [...agentMix].sort((left, right) => compareUsageMeasurementsDescending(left.tokens, right.tokens))
            .map(row => ({
                label: row.agentId ? usageAgentTitle(row.agentId) : t('usage.board.page.unattributed'),
                value: row.tokens,
            }));
        slides.push({ id: 'agentMix', label: t('usage.board.recap.field_agentMix'), value: rows[0]!.label,
            subtitle: [t('usage.tokens'), agentMix.some(row => row.tokensFromParts) ? t('usage.board.page.tokensFromParts') : null]
                .filter(Boolean).join(' · '),
            numericValue: null, visual: { kind: 'rankBars', rows } });
    }
    if (work && work.linkedOutcomes > 0) {
        slides.push(toCountSlide('work', t('usage.board.recap.statLinkedOutcomes'), work.linkedOutcomes));
    }
    if (night && (night.observedBusyMs !== null || night.recordedActivityCount !== null)) {
        const window = t('usage.board.howYouWork.nightWindow', { start: formatUsageChartClock(night.startHour),
            end: formatUsageChartClock(night.endHour), offset: formatUsageUtcOffset(recap.period.timeZoneOffsetMinutes) });
        const value = night.recordedActivityCount !== null
            ? t('usage.board.howYouWork.eventCount', { count: formatTokenCountLong(night.recordedActivityCount) })
            : formatUsageDurationCompact(night.observedBusyMs!, getPreferredLanguage());
        const subtitle = t(night.recordedActivityCount !== null
            ? 'usage.board.howYouWork.nightEventsSub' : 'usage.board.howYouWork.nightBusySub', { window });
        slides.push({ id: 'night', label: t('usage.board.recap.statNight'), value, subtitle, numericValue: null, visual: null });
    }
    if (parallel && parallel.maximumConcurrency > 0) {
        const coverage = recap.coverage.intervals;
        const subtitle = coverage?.status === 'partial' || coverage?.detailStatus === 'partial'
            ? t('usage.board.coach.coverage_partial') : '';
        slides.push(toCountSlide('parallel', t('usage.board.recap.statAtOnce'), parallel.maximumConcurrency, subtitle));
    }
    if (coach) {
        const coverage = recap.coverage.coach;
        const subtitle = coverage?.currentness === 'stale' ? t('usage.board.coach.staleEvidence')
            : coverage?.findings.includes('partial') ? t('usage.board.coach.coverage_partial') : '';
        slides.push(toCountSlide('coach', t('usage.board.recap.statCoach'), coach.findings.length, subtitle));
    }
}

export function buildRecapStorySlides(input: Parameters<typeof buildUsageRecapCardModels>[0] & Readonly<{
    cacheSavings: UsageCacheSavingsViewModel | null;
    recap?: UsageRecapComposed;
}>): RecapStorySlide[] {
    const cards = buildUsageRecapCardModels(input);
    if (cards.length === 0) {
        return [];
    }

    const byId = new Map(cards.map((card) => [card.id, card]));
    const slides: RecapStorySlide[] = [];

    const usage = byId.get('usage');
    if (usage) {
        slides.push(toSlide(usage, input.filters.metric === 'cost' && input.shareFields?.dollars !== false
            ? input.viewModel.overview.totalCost
            : input.viewModel.hero.totalTokens));
    }
    const streak = byId.get('streak');
    if (streak) {
        slides.push(toSlide(streak, input.viewModel.insights.currentStreakDays));
    }
    const model = byId.get('model');
    if (model) {
        slides.push(toSlide(model, null));
    }
    if (input.cacheSavings && input.cacheSavings.cachedReadTokens !== null && input.cacheSavings.cachedReadTokens > 0) {
        slides.push({
            id: 'cache',
            label: t('usage.cacheSavings'),
            value: formatTokenCount(input.cacheSavings.cachedReadTokens),
            subtitle: t('usage.tokens'),
            numericValue: input.cacheSavings.cachedReadTokens,
            visual: null,
        });
    }
    const rhythm = byId.get('rhythm');
    if (rhythm) {
        slides.push(toSlide(rhythm, null));
    }
    if (input.recap) appendComposedSlides(slides, input.recap);

    return slides;
}
