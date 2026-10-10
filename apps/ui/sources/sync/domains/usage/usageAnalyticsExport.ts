import { t } from '@/text';
import type { UsageAnalyticsViewModel, UsageFilterState, UsagePivotDimension } from '@/sync/api/account/usageAnalytics';
import { buildUsagePivotView } from '@/sync/api/account/usageAnalytics';
import { getUsagePeriodDefinition } from '@/sync/api/account/usagePeriods';
import { formatTokenCountLong, formatUsageCost } from '@/utils/format/usageNumbers';
import { buildUsageRecapCardModels, type UsageRecapCardAccentTone, type UsageRecapCardId, type UsageRecapCardValueTone } from './recap/buildUsageRecapCardModels';
import { resolveUsageCostModeLabel } from './resolveUsageCostModeLabel';
import { buildUsageCsvDocument } from '@happier-dev/protocol/usage/usageExport';

export type UsageAnalyticsExportInput = Readonly<{
    viewModel: UsageAnalyticsViewModel;
    filters: UsageFilterState;
    sessionId?: string | null;
    /** The active Band-5 pivot dimension whose table is exported (E-5). */
    pivotDimension?: UsagePivotDimension;
}>;

export type UsagePivotTableRowExport = Readonly<{
    rank: number;
    key: string;
    name: string;
    tokens: number;
    cost: number;
    events: number;
    sharePct: number;
}>;

export type UsagePivotTableExport = Readonly<{
    dimension: UsagePivotDimension;
    rows: readonly UsagePivotTableRowExport[];
}>;

export type UsageAnalyticsExportPayload = Readonly<{
    exportedAt: string;
    sessionId: string | null;
    filters: UsageFilterState;
    viewModel: UsageAnalyticsViewModel;
    recapCards: readonly UsageRecapCardExportPayload[];
    /** The active pivot dimension's ranked table (E-5); omitted when no dimension is active. */
    pivotTable: UsagePivotTableExport | null;
}>;

const DEFAULT_PIVOT_DIMENSION: UsagePivotDimension = 'model';

/** The active pivot dimension's ranked rows, flattened for CSV/JSON export (E-5). */
export function buildUsagePivotTableExport(input: UsageAnalyticsExportInput): UsagePivotTableExport {
    const dimension = input.pivotDimension ?? DEFAULT_PIVOT_DIMENSION;
    const view = buildUsagePivotView(input.viewModel.breakdowns, input.viewModel.leaderTrends, dimension);
    return {
        dimension,
        rows: view.rows.map((entry, index) => ({
            rank: index + 1,
            key: entry.row.key,
            name: entry.row.label,
            tokens: entry.row.totalTokens,
            cost: entry.row.totalCost,
            events: entry.row.reportCount,
            sharePct: entry.sharePct,
        })),
    };
}

/**
 * The active pivot dimension's table as CSV (E-5). Header + one row per ranked
 * entry: rank, key, name, tokens, cost, events, share%. Raw numeric values (no
 * locale formatting) so the export is machine-parseable.
 */
export function buildUsagePivotCsv(input: UsageAnalyticsExportInput): string {
    const table = buildUsagePivotTableExport(input);
    return buildUsageCsvDocument([
        ['rank', 'key', 'name', 'tokens', 'cost', 'events', 'share_pct'],
        ...table.rows.map((row) => [
            String(row.rank),
            row.key,
            row.name,
            String(row.tokens),
            String(row.cost),
            String(row.events),
            row.sharePct.toFixed(2),
        ]),
    ]);
}

export type UsageRecapCardExportPayload = Readonly<{
    id: UsageRecapCardId;
    label: string;
    value: string;
    subtitle: string;
    valueTone: UsageRecapCardValueTone;
    accentTone: UsageRecapCardAccentTone;
    visualKind: 'activityMatrix' | 'progress' | 'rankBars';
}>;

export type UsageRecapCardExportInput = UsageAnalyticsExportInput & Readonly<{
    cardId: UsageRecapCardId;
}>;

function formatPeriodLabel(period: UsageFilterState['period']): string {
    return t(getUsagePeriodDefinition(period).translationKey);
}

function formatTimelineLeaderLabel(input: UsageAnalyticsViewModel['modelTimeline'] | UsageAnalyticsViewModel['engineTimeline']): string | null {
    const mostRecentBucket = [...input].sort((left, right) => right.bucketStartMs - left.bucketStartMs)[0];
    return mostRecentBucket?.leaders[0]?.label ?? null;
}

export function buildUsageAnalyticsExportPayload(input: UsageAnalyticsExportInput): UsageAnalyticsExportPayload {
    const recapCards = buildUsageRecapCardModels({
        viewModel: input.viewModel,
        filters: input.filters,
    }).map((card) => ({
        id: card.id,
        label: card.label,
        value: card.value,
        subtitle: card.subtitle,
        valueTone: card.valueTone,
        accentTone: card.accentTone,
        visualKind: card.visual.kind,
    }));

    return {
        exportedAt: new Date().toISOString(),
        sessionId: input.sessionId ?? null,
        filters: input.filters,
        viewModel: input.viewModel,
        recapCards,
        pivotTable: buildUsagePivotTableExport(input),
    };
}

export function buildUsageAnalyticsSummaryText(input: UsageAnalyticsExportInput): string {
    const payload = buildUsageAnalyticsExportPayload(input);
    const modelTimelineLabel = formatTimelineLeaderLabel(input.viewModel.modelTimeline);
    const engineTimelineLabel = formatTimelineLeaderLabel(input.viewModel.engineTimeline);
    const costModeLabel = resolveUsageCostModeLabel({
        availableCostModes: input.viewModel.availableCostModes,
        mode: payload.viewModel.costPresentation.mode,
    });

    const lines = [
        t('usage.summary.title'),
        payload.sessionId ? `${t('usage.summary.export.session')}: ${payload.sessionId}` : null,
        `${t('usage.summary.export.period')}: ${formatPeriodLabel(payload.filters.period)}`,
        `${t('usage.summary.export.metric')}: ${payload.filters.metric}`,
        `${t('usage.summary.export.costMode')}: ${costModeLabel}`,
        `${t('usage.summary.export.totalTokens')}: ${formatTokenCountLong(payload.viewModel.overview.totalTokens)}`,
        `${t('usage.summary.export.totalCost')}: ${formatUsageCost(payload.viewModel.overview.totalCost, payload.viewModel.costPresentation.currency)}`,
        `${t('usage.summary.currentStreak')}: ${payload.viewModel.insights.currentStreakDays}d`,
        `${t('usage.summary.export.activeDays')}: ${payload.viewModel.insights.activeDays}`,
        `${t('usage.summary.export.topModel')}: ${payload.viewModel.insights.favoriteModel?.label ?? payload.viewModel.breakdowns.models[0]?.label ?? t('usage.noData.title')}`,
        `${t('usage.summary.export.topEngine')}: ${payload.viewModel.leaders.engines[0]?.label ?? t('usage.noData.title')}`,
        `${t('usage.summary.export.modelTimeline')}: ${modelTimelineLabel ?? t('usage.noData.title')}`,
        `${t('usage.summary.export.engineTimeline')}: ${engineTimelineLabel ?? t('usage.noData.title')}`,
    ].filter((line): line is string => typeof line === 'string' && line.length > 0);

    return lines.join('\n');
}

export function buildUsageRecapCardSummaryText(input: UsageRecapCardExportInput): string {
    const payload = buildUsageAnalyticsExportPayload(input);
    const recapCard = payload.recapCards.find((card) => card.id === input.cardId);
    if (!recapCard) {
        return buildUsageAnalyticsSummaryText(input);
    }

    const costModeLabel = resolveUsageCostModeLabel({
        availableCostModes: input.viewModel.availableCostModes,
        mode: payload.viewModel.costPresentation.mode,
    });

    const lines = [
        t('usage.summary.title'),
        payload.sessionId ? `${t('usage.summary.export.session')}: ${payload.sessionId}` : null,
        `${recapCard.label}: ${recapCard.value}`,
        recapCard.subtitle,
        `${t('usage.summary.export.period')}: ${formatPeriodLabel(payload.filters.period)}`,
        `${t('usage.summary.export.metric')}: ${payload.filters.metric}`,
        `${t('usage.summary.export.costMode')}: ${costModeLabel}`,
    ].filter((line): line is string => typeof line === 'string' && line.length > 0);

    return lines.join('\n');
}
