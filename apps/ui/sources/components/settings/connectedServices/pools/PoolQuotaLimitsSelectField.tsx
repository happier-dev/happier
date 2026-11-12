import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { Icon } from '@/components/ui/icons/Icon';
import { t } from '@/text';
import {
    isConnectedServiceQuotaCreditMeter,
    resolveConnectedServiceQuotaMeterLimitIdentity,
    type ConnectedServiceAuthGroupQuotaLimitSelectionV1,
    type ConnectedServiceQuotaSnapshotV1,
} from '@happier-dev/protocol';

import { MultiSelectField, type MultiSelectCandidate } from '@/components/ui/forms/dropdown/MultiSelectField';

export type PoolQuotaLimitCandidate = MultiSelectCandidate & Readonly<{
    reported: boolean;
    modelLabel?: string;
    windowCount: number;
    windowSummary: string | null;
    reportingAccountCount: number;
    totalAccountCount: number;
}>;
// A whitespace-only value cannot collide with a provider limit id: the wire schema
// trims and rejects it. It remains local to this menu and is never persisted.
const ALL_QUOTA_LIMITS_OPTION_ID = ' ';

export function buildPoolQuotaLimitCandidates(input: Readonly<{
    snapshots: ReadonlyArray<ConnectedServiceQuotaSnapshotV1 | null>;
    selection?: ConnectedServiceAuthGroupQuotaLimitSelectionV1;
}>): ReadonlyArray<PoolQuotaLimitCandidate> {
    type Aggregate = {
        title: string;
        usesNeutralTitle: boolean;
        modelLabel: string | null;
        reporterIndexes: Set<number>;
        windowDurationsById: Map<string, number | null>;
    };
    const byId = new Map<string, Aggregate>();
    input.snapshots.forEach((snapshot, snapshotIndex) => {
        for (const meter of snapshot?.meters ?? []) {
            // Credits are account-wide spend that every selection keeps, not a selectable allowance.
            if (isConnectedServiceQuotaCreditMeter(meter)) continue;
            const id = resolveConnectedServiceQuotaMeterLimitIdentity(meter);
            const meterTitle = meter.label.replace(/\s+·\s+(?:Primary|Secondary)$/i, '').trim();
            const fallbackTitle = formatProviderLimitId(id);
            const usesNeutralTitle = isOpaqueUnknownLabel(meterTitle);
            const title = usesNeutralTitle
                ? t('connectedServices.pools.detail.quotaLimitProviderTitle')
                : /^(?:primary|secondary)$/i.test(meterTitle) ? fallbackTitle : meterTitle || fallbackTitle;
            const modelLabel = readModelDisplayName(meter.details) ?? meter.modelId?.trim() ?? null;
            const entry = byId.get(id) ?? {
                title,
                usesNeutralTitle,
                modelLabel,
                reporterIndexes: new Set<number>(),
                windowDurationsById: new Map<string, number | null>(),
            };
            entry.reporterIndexes.add(snapshotIndex);
            const windowId = meter.scope?.trim() || meter.meterId;
            const duration = meter.windowDurationMs ?? null;
            const existingDuration = entry.windowDurationsById.get(windowId);
            entry.windowDurationsById.set(
                windowId,
                existingDuration === undefined || existingDuration === duration ? duration : null,
            );
            if (entry.usesNeutralTitle && !usesNeutralTitle) {
                entry.title = title;
                entry.usesNeutralTitle = false;
            }
            if (!entry.modelLabel && modelLabel) entry.modelLabel = modelLabel;
            byId.set(id, entry);
        }
    });
    if (input.selection?.mode === 'selected') {
        for (const id of input.selection.providerLimitIds) {
            if (!byId.has(id)) {
                byId.set(id, {
                    title: isOpaqueUnknownProviderLimitId(id)
                        ? t('connectedServices.pools.detail.quotaLimitProviderTitle')
                        : formatProviderLimitId(id),
                    usesNeutralTitle: isOpaqueUnknownProviderLimitId(id),
                    modelLabel: null,
                    reporterIndexes: new Set<number>(),
                    windowDurationsById: new Map<string, number | null>(),
                });
            }
        }
    }
    return Array.from(byId, ([id, entry]) => {
        const reportingAccountCount = entry.reporterIndexes.size;
        const windowCount = entry.windowDurationsById.size;
        const windowDurations = Array.from(entry.windowDurationsById.values());
        const windowSummary = windowDurations.length > 0 && windowDurations.every((duration) => duration !== null)
            ? Array.from(new Set(windowDurations as number[]))
                .sort((a, b) => a - b)
                .map(formatQuotaWindowDuration)
                .join(' + ')
            : null;
        const reported = reportingAccountCount > 0;
        const modelAlreadyInTitle = entry.modelLabel
            ? entry.title.toLocaleLowerCase().includes(entry.modelLabel.toLocaleLowerCase())
            : false;
        let subtitle: string;
        if (!reported) {
            subtitle = t('connectedServices.pools.detail.quotaLimitNotReportedWithId', { id });
        } else if (entry.usesNeutralTitle) {
            subtitle = t('connectedServices.pools.detail.quotaLimitProviderDetails', {
                id,
                windowCount,
                windowSummary,
                accountCount: reportingAccountCount,
                totalAccountCount: input.snapshots.length,
            });
        } else if (entry.modelLabel && !modelAlreadyInTitle) {
            subtitle = t('connectedServices.pools.detail.quotaLimitModelDetails', {
                model: entry.modelLabel,
                windowCount,
                windowSummary,
                accountCount: reportingAccountCount,
                totalAccountCount: input.snapshots.length,
            });
        } else {
            subtitle = t('connectedServices.pools.detail.quotaLimitDetails', {
                windowCount,
                windowSummary,
                accountCount: reportingAccountCount,
                totalAccountCount: input.snapshots.length,
            });
        }
        return {
            id,
            title: entry.title,
            reported,
            ...(entry.modelLabel ? { modelLabel: entry.modelLabel } : {}),
            windowCount,
            windowSummary,
            reportingAccountCount,
            totalAccountCount: input.snapshots.length,
            subtitle,
        };
    }).sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
}

function formatQuotaWindowDuration(durationMs: number): string {
    const totalMinutes = Math.max(1, Math.round(durationMs / 60_000));
    const days = Math.floor(totalMinutes / (24 * 60));
    const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
    const minutes = totalMinutes % 60;
    if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
    if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
    return `${minutes}m`;
}

function readModelDisplayName(details: unknown): string | null {
    if (!details || typeof details !== 'object' || Array.isArray(details)) return null;
    const value = Reflect.get(details, 'modelDisplayName');
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function formatProviderLimitId(id: string): string {
    const words = id.split(/[-_.:]+/).filter(Boolean);
    if (words.length === 0) return id;
    return words.map((word) => word === word.toUpperCase()
        ? word
        : `${word.charAt(0).toUpperCase()}${word.slice(1)}`).join(' ');
}

function isOpaqueUnknownProviderLimitId(id: string): boolean {
    return /^(?:unknown|unreported|unavailable)(?:[-_.:]?(?:limit|allowance))?$/i.test(id.trim());
}

function isOpaqueUnknownLabel(label: string): boolean {
    return /^(?:unknown|unreported|unavailable)(?:\s+(?:limit|allowance))?$/i.test(label.trim());
}

export const PoolQuotaLimitsSelectField = React.memo(function PoolQuotaLimitsSelectField(props: Readonly<{
    snapshots: ReadonlyArray<ConnectedServiceQuotaSnapshotV1 | null>;
    selection?: ConnectedServiceAuthGroupQuotaLimitSelectionV1;
    onChange: (selection: ConnectedServiceAuthGroupQuotaLimitSelectionV1) => void;
    loadingProfileCount?: number;
    disabled?: boolean;
}>) {
    const { theme } = useUnistyles();
    const candidates = React.useMemo(
        () => buildPoolQuotaLimitCandidates({ snapshots: props.snapshots, selection: props.selection }),
        [props.selection, props.snapshots],
    );
    const selectedIds = props.selection?.mode === 'selected'
        ? props.selection.providerLimitIds
        : [ALL_QUOTA_LIMITS_OPTION_ID];
    const menuCandidates = React.useMemo(() => [{
        id: ALL_QUOTA_LIMITS_OPTION_ID,
        title: t('connectedServices.pools.detail.quotaLimitsAll'),
        subtitle: props.loadingProfileCount
            ? t('connectedServices.pools.detail.quotaLimitsRefreshing', { count: props.loadingProfileCount })
            : t('connectedServices.pools.detail.quotaLimitsAllDescription'),
    }, ...candidates], [candidates, props.loadingProfileCount]);
    return (
        <MultiSelectField
            testID="connected-services-pool-detail:quota-limits"
            candidates={menuCandidates}
            selectedIds={selectedIds}
            onCommit={(ids) => {
                props.onChange(ids.includes(ALL_QUOTA_LIMITS_OPTION_ID)
                    ? { mode: 'all', providerLimitIds: [] }
                    : { mode: 'selected', providerLimitIds: ids.filter((id) => id !== ALL_QUOTA_LIMITS_OPTION_ID) });
            }}
            title={t('connectedServices.pools.detail.quotaLimitsTitle')}
            subtitle={() => props.selection?.mode === 'selected'
                ? t('connectedServices.pools.detail.quotaLimitsSelected', { count: props.selection.providerLimitIds.length })
                : t('connectedServices.pools.detail.quotaLimitsAll')}
            emptySubtitle={t('connectedServices.pools.detail.quotaLimitsUnavailable')}
            searchPlaceholder={t('connectedServices.pools.detail.quotaLimitsSearch')}
            optionTestIDPrefix="connected-services-pool-detail:quota-limits:option"
            icon={<Icon name="chart-line" size={20} color={theme.colors.accent.blue} />}
            disabled={props.disabled}
            minimumSelected={1}
            exclusiveId={ALL_QUOTA_LIMITS_OPTION_ID}
        />
    );
});
