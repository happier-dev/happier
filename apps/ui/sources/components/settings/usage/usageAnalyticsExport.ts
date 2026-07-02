import { Platform } from 'react-native';

import { setClipboardStringSafe } from '@/utils/ui/clipboard';
import { t } from '@/text';
import type { UsageAnalyticsViewModel, UsageFilterState } from '@/sync/api/account/usageAnalytics';
import { getUsagePeriodDefinition } from '@/sync/api/account/usagePeriods';
import {
    buildUsageRecapCardModels,
    type UsageRecapCardAccentTone,
    type UsageRecapCardId,
    type UsageRecapCardValueTone,
} from './buildUsageRecapCardModels';
import { formatUsageCurrency } from './formatUsageCurrency';
import { resolveUsageCostModeLabel } from './resolveUsageCostModeLabel';

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
    recapCards: readonly UsageRecapCardExportPayload[];
}>;

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

function formatFileTimestamp(date: Date): string {
    return date.toISOString().replace(/[:.]/g, '-');
}

type ExpoFileSystemDirectory = Readonly<{
    uri: string;
}>;

type ExpoFileSystemFile = Readonly<{
    uri: string;
    write: (content: string) => void;
    delete: () => void;
}>;

type ExpoFileSystemModule = Readonly<{
    File: new (parent: ExpoFileSystemDirectory | string, name: string) => ExpoFileSystemFile;
    Paths?: Readonly<{
        cache?: ExpoFileSystemDirectory | string | null;
        document?: ExpoFileSystemDirectory | string | null;
    }>;
}>;

type ExpoSharingModule = Readonly<{
    isAvailableAsync?: () => Promise<boolean>;
    shareAsync?: (uri: string) => Promise<void>;
}>;

async function writeNativeCacheTextFile(input: Readonly<{
    content: string;
    fileName: string;
}>): Promise<ExpoFileSystemFile | null> {
    const FileSystem = await import('expo-file-system') as ExpoFileSystemModule;
    const baseDirectory = FileSystem.Paths?.cache ?? FileSystem.Paths?.document ?? null;
    if (!baseDirectory) {
        return null;
    }

    const file = new FileSystem.File(baseDirectory, input.fileName);
    file.write(input.content);
    return file;
}

function deleteNativeFileBestEffort(file: ExpoFileSystemFile): void {
    try {
        file.delete();
    } catch {
        // best effort
    }
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
    try {
        const Sharing = await import('expo-sharing') as ExpoSharingModule;
        const file = await writeNativeCacheTextFile({
            content: text,
            fileName: `usage-summary-${formatFileTimestamp(new Date())}.txt`,
        });
        if (!file) {
            return setClipboardStringSafe(text);
        }

        try {
            if (typeof Sharing.isAvailableAsync === 'function' && typeof Sharing.shareAsync === 'function') {
                const available = await Sharing.isAvailableAsync();
                if (available) {
                    await Sharing.shareAsync(file.uri);
                    return true;
                }
            }
        } finally {
            deleteNativeFileBestEffort(file);
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

export async function shareUsageRecapCardSummary(input: UsageRecapCardExportInput): Promise<boolean> {
    const summaryText = buildUsageRecapCardSummaryText(input);
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
        const Sharing = await import('expo-sharing') as ExpoSharingModule;
        const file = await writeNativeCacheTextFile({
            content: `${JSON.stringify(payload, null, 2)}\n`,
            fileName: `usage-${formatFileTimestamp(new Date())}.json`,
        });
        if (!file) {
            return false;
        }

        try {
            if (typeof Sharing.isAvailableAsync === 'function' && typeof Sharing.shareAsync === 'function') {
                const available = await Sharing.isAvailableAsync();
                if (available) {
                    await Sharing.shareAsync(file.uri);
                    return true;
                }
            }
        } finally {
            deleteNativeFileBestEffort(file);
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
