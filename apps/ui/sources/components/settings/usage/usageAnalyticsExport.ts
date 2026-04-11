import { Platform } from 'react-native';

import { setClipboardStringSafe } from '@/utils/ui/clipboard';
import { t } from '@/text';
import type { UsageAnalyticsViewModel, UsageFilterState } from '@/sync/api/account/usageAnalytics';
import { formatUsageCurrency } from './formatUsageCurrency';

export type UsageAnalyticsExportInput = Readonly<{
    viewModel: UsageAnalyticsViewModel;
    filters: UsageFilterState;
    sessionId?: string | null;
}>;

export type UsageAnalyticsExportPayload = Readonly<{
    exportedAt: string;
    sessionId: string | null;
    filters: UsageFilterState;
    viewModel: UsageAnalyticsViewModel;
}>;

function formatPeriodLabel(period: UsageFilterState['period']): string {
    if (period === 'today') return t('usage.today');
    if (period === '7days') return t('usage.last7Days');
    return t('usage.last30Days');
}

function formatTimelineLeaderLabel(input: UsageAnalyticsViewModel['modelTimeline'] | UsageAnalyticsViewModel['engineTimeline']): string | null {
    const mostRecentBucket = [...input].sort((left, right) => right.bucketStartMs - left.bucketStartMs)[0];
    return mostRecentBucket?.leaders[0]?.label ?? null;
}

function formatFileTimestamp(date: Date): string {
    return date.toISOString().replace(/[:.]/g, '-');
}

export function buildUsageAnalyticsExportPayload(input: UsageAnalyticsExportInput): UsageAnalyticsExportPayload {
    return {
        exportedAt: new Date().toISOString(),
        sessionId: input.sessionId ?? null,
        filters: input.filters,
        viewModel: input.viewModel,
    };
}

export function buildUsageAnalyticsSummaryText(input: UsageAnalyticsExportInput): string {
    const payload = buildUsageAnalyticsExportPayload(input);
    const modelTimelineLabel = formatTimelineLeaderLabel(input.viewModel.modelTimeline);
    const engineTimelineLabel = formatTimelineLeaderLabel(input.viewModel.engineTimeline);
    const costModeLabel = input.viewModel.availableCostModes.length === 1 && input.viewModel.availableCostModes[0] === 'auto'
        ? t('usage.auto')
        : payload.viewModel.costPresentation.mode === 'reported'
            ? t('usage.reported')
            : payload.viewModel.costPresentation.mode === 'estimated'
                ? t('usage.estimated')
                : t('usage.auto');

    const lines = [
        t('usage.summary.title'),
        payload.sessionId ? `${t('usage.summary.export.session')}: ${payload.sessionId}` : null,
        `${t('usage.summary.export.period')}: ${formatPeriodLabel(payload.filters.period)}`,
        `${t('usage.summary.export.metric')}: ${payload.filters.metric}`,
        `${t('usage.summary.export.costMode')}: ${costModeLabel}`,
        `${t('usage.summary.export.totalTokens')}: ${payload.viewModel.overview.totalTokens.toLocaleString()}`,
        `${t('usage.summary.export.totalCost')}: ${formatUsageCurrency(payload.viewModel.overview.totalCost, payload.viewModel.costPresentation.currency)}`,
        `${t('usage.summary.currentStreak')}: ${payload.viewModel.insights.currentStreakDays}d`,
        `${t('usage.summary.export.activeDays')}: ${payload.viewModel.insights.activeDays}`,
        `${t('usage.summary.export.topModel')}: ${payload.viewModel.insights.favoriteModel?.label ?? payload.viewModel.breakdowns.models[0]?.label ?? t('usage.noData')}`,
        `${t('usage.summary.export.topEngine')}: ${payload.viewModel.leaders.engines[0]?.label ?? t('usage.noData')}`,
        `${t('usage.summary.export.modelTimeline')}: ${modelTimelineLabel ?? t('usage.noData')}`,
        `${t('usage.summary.export.engineTimeline')}: ${engineTimelineLabel ?? t('usage.noData')}`,
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
    try {
        const FileSystem: any = await import('expo-file-system');
        const Sharing: any = await import('expo-sharing');
        const baseDirectory: string | null = FileSystem.cacheDirectory ?? FileSystem.documentDirectory ?? null;
        if (!baseDirectory) {
            return setClipboardStringSafe(text);
        }

        const fileUri = `${baseDirectory.replace(/\/+$/, '')}/usage-summary-${formatFileTimestamp(new Date())}.txt`;
        await FileSystem.writeAsStringAsync(fileUri, text, { encoding: FileSystem.EncodingType.UTF8 });
        try {
            if (Sharing && typeof Sharing.isAvailableAsync === 'function' && typeof Sharing.shareAsync === 'function') {
                const available = await Sharing.isAvailableAsync();
                if (available) {
                    await Sharing.shareAsync(fileUri);
                    return true;
                }
            }
        } finally {
            try {
                await FileSystem.deleteAsync(fileUri, { idempotent: true });
            } catch {
                // best effort
            }
        }

        return setClipboardStringSafe(text);
    } catch {
        return setClipboardStringSafe(text);
    }
}

export async function shareUsageAnalyticsSummary(input: UsageAnalyticsExportInput): Promise<boolean> {
    const summaryText = buildUsageAnalyticsSummaryText(input);
    if (Platform.OS === 'web') {
        return await shareTextOnWeb(summaryText);
    }
    return await shareTextOnNative(summaryText);
}

async function downloadJsonOnWeb(payload: UsageAnalyticsExportPayload): Promise<boolean> {
    const blob = new Blob([`${JSON.stringify(payload, null, 2)}\n`], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    try {
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = `usage-${formatFileTimestamp(new Date())}.json`;
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
        setTimeout(() => {
            try {
                anchor.remove();
            } catch {
                // ignore
            }
        }, 0);
    } finally {
        setTimeout(() => {
            try {
                URL.revokeObjectURL(url);
            } catch {
                // ignore
            }
        }, 1000);
    }
    return true;
}

async function downloadJsonOnNative(payload: UsageAnalyticsExportPayload): Promise<boolean> {
    try {
        const FileSystem: any = await import('expo-file-system');
        const Sharing: any = await import('expo-sharing');
        const baseDirectory: string | null = FileSystem.cacheDirectory ?? FileSystem.documentDirectory ?? null;
        if (!baseDirectory) {
            return false;
        }

        const fileUri = `${baseDirectory.replace(/\/+$/, '')}/usage-${formatFileTimestamp(new Date())}.json`;
        await FileSystem.writeAsStringAsync(fileUri, `${JSON.stringify(payload, null, 2)}\n`, { encoding: FileSystem.EncodingType.UTF8 });
        try {
            if (Sharing && typeof Sharing.isAvailableAsync === 'function' && typeof Sharing.shareAsync === 'function') {
                const available = await Sharing.isAvailableAsync();
                if (available) {
                    await Sharing.shareAsync(fileUri);
                    return true;
                }
            }
        } finally {
            try {
                await FileSystem.deleteAsync(fileUri, { idempotent: true });
            } catch {
                // best effort
            }
        }

        return false;
    } catch {
        return false;
    }
}

export async function exportUsageAnalyticsJson(input: UsageAnalyticsExportInput): Promise<boolean> {
    const payload = buildUsageAnalyticsExportPayload(input);
    if (Platform.OS === 'web') {
        return await downloadJsonOnWeb(payload);
    }
    return await downloadJsonOnNative(payload);
}
