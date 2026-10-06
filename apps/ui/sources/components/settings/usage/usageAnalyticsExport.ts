import { Platform } from 'react-native';
import { log } from '@/log';
import { createNativeCacheFileSink, shareNativeCacheFile } from '@/sync/runtime/files/nativeCacheFileSink';

import { setClipboardStringSafe } from '@/utils/ui/clipboard';
import { t } from '@/text';
import type {
    UsageAnalyticsViewModel,
    UsageFilterState,
    UsagePivotDimension,
} from '@/sync/api/account/usageAnalytics';
import { buildUsagePivotView } from '@/sync/api/account/usageAnalytics';
import { getUsagePeriodDefinition } from '@/sync/api/account/usagePeriods';
import { formatTokenCountLong, formatUsageCost } from '@/utils/format/usageNumbers';
import {
    buildUsageRecapCardModels,
    type UsageRecapCardAccentTone,
    type UsageRecapCardId,
    type UsageRecapCardValueTone,
} from './buildUsageRecapCardModels';
import { resolveUsageCostModeLabel } from './resolveUsageCostModeLabel';
import {
    buildUsageCsvDocument,
    exportUsageCsvDocument,
    exportUsageTextDocument,
    formatUsageExportFileTimestamp,
    shareUsageExportCacheFile,
} from './usageExportFile';

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

async function shareTextOnWeb(text: string): Promise<boolean> {
    if (typeof navigator !== 'undefined' && typeof (navigator as { share?: unknown }).share === 'function') {
        await (navigator as Navigator & { share: (data: { title?: string; text?: string }) => Promise<void> }).share({
            title: t('usage.summary.title'),
            text,
        });
        return true;
    }

    return setClipboardStringSafe(text);
}

async function shareTextOnNative(text: string): Promise<boolean> {
    const shared = await shareUsageExportCacheFile({
        content: text,
        fileName: `usage-summary-${formatUsageExportFileTimestamp(new Date())}.txt`,
    });
    // A platform that cannot take the file still owes the reader the numbers,
    // so the summary goes to the clipboard rather than silently failing.
    return shared ? true : setClipboardStringSafe(text);
}

export async function shareUsageAnalyticsSummary(input: UsageAnalyticsExportInput): Promise<boolean> {
    const summaryText = buildUsageAnalyticsSummaryText(input);
    if (Platform.OS === 'web') {
        return await shareTextOnWeb(summaryText);
    }
    return await shareTextOnNative(summaryText);
}

export async function shareUsageRecapCardSummary(input: UsageRecapCardExportInput): Promise<boolean> {
    const summaryText = buildUsageRecapCardSummaryText(input);
    if (Platform.OS === 'web') {
        return await shareTextOnWeb(summaryText);
    }
    return await shareTextOnNative(summaryText);
}

function downloadDataUriOnWeb(dataUri: string, fileName: string): boolean {
    try {
        const anchor = document.createElement('a');
        anchor.href = dataUri;
        anchor.download = fileName;
        anchor.rel = 'noopener noreferrer';
        try {
            anchor.style.display = 'none';
        } catch {
            // ignore
        }
        try {
            document.body?.appendChild(anchor);
        } catch {
            // ignore
        }
        anchor.click();
        try {
            anchor.remove();
        } catch {
            // ignore
        }
        return true;
    } catch {
        return false;
    }
}

/**
 * Share a rendered recap story card as a PNG image. Captures the given view
 * via react-native-view-shot (already a dependency; same pattern as the tour's
 * `captureStageFrame`), then shares through the native cache owner or downloads
 * on web. Falls back to the text summary share when capture/share fails.
 */
export async function shareUsageRecapCardImage(
    input: UsageRecapCardExportInput & Readonly<{ node: unknown }>,
): Promise<boolean> {
    try {
        if (Platform.OS === 'web') {
            const viewShotWeb = (await import('react-native-view-shot/src/RNViewShot.web')).default;
            const dataUri = await viewShotWeb.captureRef(input.node, {
                format: 'png',
                quality: 1,
                result: 'data-uri',
            });
            if (downloadDataUriOnWeb(dataUri, `usage-recap-${input.cardId}-${formatUsageExportFileTimestamp(new Date())}.png`)) {
                return true;
            }
            return await shareUsageRecapCardSummary(input);
        }

        const { captureRef, releaseCapture } = await import('react-native-view-shot');
        // Boundary cast: callers pass a mounted native view ref (same contract
        // as the tour's captureStageFrame).
        const captureSource = input.node as Parameters<typeof captureRef>[0];
        const uri = await captureRef(captureSource, {
            format: 'png',
            quality: 1,
            result: 'tmpfile',
        });
        try {
            const name = `usage-recap-${input.cardId}-${formatUsageExportFileTimestamp(new Date())}.png`;
            const sink = await createNativeCacheFileSink({ directoryName: 'happier-downloads', fileName: name });
            if (!sink.ok) throw new Error(sink.error);
            let retainCacheFile = false;
            try {
                // Legacy's standard copyAsync overwrites the closed sink file;
                // modern File.copy rejects an already-created destination.
                await sink.close();
                const { copyAsync } = await import('expo-file-system/legacy');
                await copyAsync({ from: uri, to: sink.fileUri });
                const result = await shareNativeCacheFile({ fileUri: sink.fileUri, name, mimeType: 'image/png' });
                if (result.status === 'shared') {
                    retainCacheFile = result.retainCacheFile;
                    return true;
                }
            } finally {
                if (!retainCacheFile) await sink.cleanup();
            }
        } finally {
            releaseCapture(uri);
        }
        return await shareUsageRecapCardSummary(input);
    } catch (error) {
        log.log(`Failed to export usage recap image: ${error instanceof Error ? error.message : String(error)}`);
        return await shareUsageRecapCardSummary(input);
    }
}

export async function exportUsageAnalyticsJson(input: UsageAnalyticsExportInput): Promise<boolean> {
    const payload = buildUsageAnalyticsExportPayload(input);
    return await exportUsageTextDocument({
        content: `${JSON.stringify(payload, null, 2)}\n`,
        fileName: `usage-${formatUsageExportFileTimestamp(new Date())}.json`,
        mimeType: 'application/json',
    });
}

/**
 * Export the active pivot dimension's ranked table as CSV (E-5). Reuses the same
 * web download / native share plumbing as the JSON export — no new export UI,
 * just the additional format on the existing actions row.
 */
export async function exportUsagePivotCsv(input: UsageAnalyticsExportInput): Promise<boolean> {
    const table = buildUsagePivotTableExport(input);
    return await exportUsageCsvDocument({
        csv: buildUsagePivotCsv(input),
        fileName: `usage-${table.dimension}-${formatUsageExportFileTimestamp(new Date())}.csv`,
    });
}
