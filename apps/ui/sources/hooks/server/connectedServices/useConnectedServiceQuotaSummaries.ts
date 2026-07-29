import * as React from 'react';

import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useProfile, useSettings } from '@/sync/store/hooks';
import {
    connectedServiceProfileKey,
    resolveConnectedServiceProfileLabel,
} from '@/sync/domains/connectedServices/connectedServiceProfilePreferences';
import { deriveQuotaUtilizationPct } from '@/sync/domains/connectedServices/deriveQuotaUtilizationPct';
import { shouldHideQuotaForCredentialStatus } from '@/sync/domains/connectedServices/shouldHideQuotaForCredentialStatus';
import {
    type ConnectedServiceId,
    type ConnectedServiceQuotaMeterV1,
} from '@happier-dev/protocol';

import { useConnectedServiceQuotaSnapshots } from './useConnectedServiceQuotaSnapshots';

export type ConnectedServiceQuotaSummaryMeter = Readonly<{
    meterId: string;
    label: string;
    remainingPct: number | null;
    utilizationPct: number | null;
    status: ConnectedServiceQuotaMeterV1['status'];
}>;

export type ConnectedServiceQuotaSummary = Readonly<{
    key: string;
    serviceId: ConnectedServiceId;
    profileId: string;
    profileLabel: string | null;
    planLabel: string | null;
    primaryMeter: ConnectedServiceQuotaSummaryMeter | null;
    meters: ReadonlyArray<ConnectedServiceQuotaSummaryMeter>;
}>;

function buildSummaryMeters(
    meters: ReadonlyArray<ConnectedServiceQuotaMeterV1>,
    pinnedMeterIds: ReadonlyArray<string>,
    strategy: 'primary' | 'min_remaining',
): ConnectedServiceQuotaSummary['meters'] {
    const byId = new Map(meters.map((meter) => [meter.meterId, meter] as const));
    const selectedMeters = pinnedMeterIds.length > 0
        ? pinnedMeterIds.map((meterId) => byId.get(meterId)).filter((meter): meter is ConnectedServiceQuotaMeterV1 => Boolean(meter))
        : [...meters];

    const normalized = selectedMeters.map((meter) => {
        const utilizationPct = deriveQuotaUtilizationPct(meter);
        return {
            meterId: meter.meterId,
            label: meter.label,
            utilizationPct,
            remainingPct: utilizationPct === null ? null : Math.max(0, 100 - utilizationPct),
            status: meter.status,
        } satisfies ConnectedServiceQuotaSummaryMeter;
    });

    if (strategy === 'primary') {
        return normalized.slice(0, 3);
    }

    const sorted = normalized.sort((left, right) => {
        const leftScore = left.remainingPct ?? Number.POSITIVE_INFINITY;
        const rightScore = right.remainingPct ?? Number.POSITIVE_INFINITY;
        if (leftScore !== rightScore) {
            return leftScore - rightScore;
        }
        return left.label.localeCompare(right.label);
    });

    return sorted.slice(0, 3);
}

export function useConnectedServiceQuotaSummaries(): Readonly<{
    summaries: ReadonlyArray<ConnectedServiceQuotaSummary>;
    isRefreshing: boolean;
    hasConnectedProfiles: boolean;
}> {
    const quotasEnabled = useFeatureEnabled('connectedServices.quotas');
    const profile = useProfile();
    const settings = useSettings();

    const connectedProfiles = React.useMemo(() => {
        if (!quotasEnabled) {
            return [] as Array<{ serviceId: ConnectedServiceId; profileId: string }>;
        }

        const next: Array<{ serviceId: ConnectedServiceId; profileId: string }> = [];
        const seenKeys = new Set<string>();
        for (const service of profile.connectedServicesV2) {
            for (const entry of service.profiles ?? []) {
                // Usage DISPLAY fails OPEN: skip a profile ONLY for an explicit,
                // recognized needs_reauth. Absent/unknown/'' status still shows
                // usage (single predicate shared with every quota gate).
                if (shouldHideQuotaForCredentialStatus(entry.status)) {
                    continue;
                }
                const key = connectedServiceProfileKey({
                    serviceId: service.serviceId,
                    profileId: entry.profileId,
                });
                if (seenKeys.has(key)) {
                    continue;
                }
                seenKeys.add(key);
                next.push({
                    serviceId: service.serviceId,
                    profileId: entry.profileId,
                });
            }
        }
        return next;
    }, [
        profile.connectedServicesV2,
        quotasEnabled,
    ]);

    const { snapshotsByKey, loadingByKey } = useConnectedServiceQuotaSnapshots(connectedProfiles);

    const summaries = React.useMemo(() => {
        if (!quotasEnabled) {
            return [] as ConnectedServiceQuotaSummary[];
        }

        const next: ConnectedServiceQuotaSummary[] = [];
        for (const entry of connectedProfiles) {
            const key = connectedServiceProfileKey(entry);
            const snapshot = snapshotsByKey[key];
            if (!snapshot || snapshot.meters.length === 0) {
                continue;
            }

            const pinnedMeterIds = settings.connectedServicesQuotaPinnedMeterIdsByKey[key] ?? [];
            const rawStrategy = settings.connectedServicesQuotaSummaryStrategyByKey[key];
            const strategy = rawStrategy === 'min_remaining' ? 'min_remaining' : 'primary';
            const meters = buildSummaryMeters(snapshot.meters, pinnedMeterIds, strategy);

            next.push({
                key,
                serviceId: entry.serviceId,
                profileId: entry.profileId,
                profileLabel: resolveConnectedServiceProfileLabel({
                    labelsByKey: settings.connectedServicesProfileLabelByKey,
                    serviceId: entry.serviceId,
                    profileId: entry.profileId,
                }),
                planLabel: snapshot.planLabel,
                primaryMeter: meters[0] ?? null,
                meters,
            });
        }

        return next.sort((left, right) => {
            const leftScore = left.primaryMeter?.remainingPct ?? Number.POSITIVE_INFINITY;
            const rightScore = right.primaryMeter?.remainingPct ?? Number.POSITIVE_INFINITY;
            if (leftScore !== rightScore) {
                return leftScore - rightScore;
            }
            return left.serviceId.localeCompare(right.serviceId);
        });
    }, [
        connectedProfiles,
        quotasEnabled,
        settings.connectedServicesProfileLabelByKey,
        settings.connectedServicesQuotaPinnedMeterIdsByKey,
        settings.connectedServicesQuotaSummaryStrategyByKey,
        snapshotsByKey,
    ]);

    const isRefreshing = React.useMemo(
        () => Object.values(loadingByKey).some(Boolean),
        [loadingByKey],
    );

    return {
        summaries,
        isRefreshing,
        hasConnectedProfiles: connectedProfiles.length > 0,
    };
}
