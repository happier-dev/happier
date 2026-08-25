import * as React from 'react';

import {
    useProjectedPluginLocalizedTextResolver,
    useProjectedConnectedServicesRegistry,
} from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { t } from '@/text';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useProfile, useSettings } from '@/sync/store/hooks';
import {
    resolveQualifiedConnectedAccountLabel,
    resolveConnectedServiceProfileLabel,
} from '@/sync/domains/connectedServices/connectedServiceProfilePreferences';
import {
    getLegacyConnectedServiceRegistryEntry,
    type ConnectedServiceRegistryEntry,
} from '@/sync/domains/connectedServices/connectedServiceRegistry';
import {
    resolveConnectedAccountUiNegotiation,
} from '@/sync/domains/connectedServices/resolveConnectedAccountUiNegotiation';
import {
    useServerFeaturesRuntimeSnapshot,
} from '@/sync/domains/features/featureDecisionRuntime';
import {
    selectConnectedServiceQuotaSummaryMeters,
    type ConnectedServiceQuotaSummaryStrategy,
} from '@/sync/domains/connectedServices/connectedServiceQuotaBadges';
import { shouldHideQuotaForCredentialStatus } from '@/sync/domains/connectedServices/shouldHideQuotaForCredentialStatus';
import {
    type ConnectedServiceId,
    type ConnectedServiceQuotaMeterV1,
    type PluginContributionIdentityV1,
} from '@happier-dev/protocol';

import {
    useConnectedServiceQuotaSnapshots,
} from './useConnectedServiceQuotaSnapshots';
import type {
    ConnectedServiceQuotaProfileRefInput,
} from '@/sync/domains/connectedServices/connectedServiceQuotaProfileRefs';
import {
    resolveConnectedServiceRegistryEntryDisplayName,
} from '@/components/settings/connectedServices/model/resolveConnectedServiceDisplayName';
import {
    type PluginLocalizedTextResolver,
} from '@/sync/domains/plugins/ui/i18n';

export type ConnectedServiceQuotaSummaryMeter = Readonly<{
    meterId: string;
    label: string;
    remainingPct: number | null;
    utilizationPct: number | null;
    status: ConnectedServiceQuotaMeterV1['status'];
}>;

export type ConnectedServiceQuotaSummary = Readonly<{
    key: string;
    /** Exact V4 owner identity; legacy scalar ids never escape this boundary. */
    service: PluginContributionIdentityV1;
    /** Present only for a released built-in V2/V3 compatibility projection. */
    legacyServiceId: ConnectedServiceId | null;
    /** Descriptor-derived display label, or the bounded generic fallback. */
    serviceLabel: string;
    profileId: string;
    profileLabel: string | null;
    planLabel: string | null;
    primaryMeter: ConnectedServiceQuotaSummaryMeter | null;
    meters: ReadonlyArray<ConnectedServiceQuotaSummaryMeter>;
}>;

/**
 * Projects a snapshot's meters for the usage summary through the same owner the
 * settings-row badges use, so both surfaces rank and label a meter identically.
 * Unpinned accounts summarize the snapshot's own meters; a pinned meter that the
 * snapshot no longer reports is dropped rather than shown without a value.
 */
function buildSummaryMeters(
    meters: ReadonlyArray<ConnectedServiceQuotaMeterV1>,
    pinnedMeterIds: ReadonlyArray<string>,
    strategy: ConnectedServiceQuotaSummaryStrategy,
): ConnectedServiceQuotaSummary['meters'] {
    return selectConnectedServiceQuotaSummaryMeters({
        meters,
        meterIds: pinnedMeterIds.length > 0
            ? pinnedMeterIds
            : meters.map((meter) => meter.meterId),
        strategy,
    })
        .flatMap((selected) => selected.meter
            ? [{
                meterId: selected.meterId,
                label: selected.label,
                utilizationPct: selected.utilizationPct,
                remainingPct: selected.remainingPct,
                status: selected.meter.status,
            } satisfies ConnectedServiceQuotaSummaryMeter]
            : [])
        .slice(0, 3);
}

function resolveQualifiedSummaryService(params: Readonly<{
    ref: Readonly<{ service: PluginContributionIdentityV1; accountId: string }>;
    settings: ReturnType<typeof useSettings>;
    registryEntries: readonly ConnectedServiceRegistryEntry[];
    localizePluginText: PluginLocalizedTextResolver;
}>): Readonly<{
    service: PluginContributionIdentityV1;
    legacyServiceId: ConnectedServiceId | null;
    serviceLabel: string;
    profileId: string;
    profileLabel: string | null;
}> {
    const entry = params.registryEntries.find((candidate) => (
        candidate.service?.pluginId === params.ref.service.pluginId
        && candidate.service.localId === params.ref.service.localId
    )) ?? null;
    const legacyServiceId = entry?.legacyServiceId ?? null;
    return {
        service: params.ref.service,
        legacyServiceId,
        serviceLabel: entry
            ? resolveConnectedServiceRegistryEntryDisplayName(entry, t, params.localizePluginText)
            : t('connectedServices.fallbackName'),
        profileId: params.ref.accountId,
        profileLabel: resolveQualifiedConnectedAccountLabel({
            labelsByKey: params.settings.connectedServicesProfileLabelByKey,
            service: params.ref.service,
            legacyServiceId,
            accountId: params.ref.accountId,
        }),
    };
}

function resolveLegacySummaryService(params: Readonly<{
    serviceId: ConnectedServiceId;
    profileId: string;
    settings: ReturnType<typeof useSettings>;
    localizePluginText: PluginLocalizedTextResolver;
}>): Readonly<{
    service: PluginContributionIdentityV1;
    legacyServiceId: ConnectedServiceId;
    serviceLabel: string;
    profileId: string;
    profileLabel: string | null;
}> | null {
    const entry = getLegacyConnectedServiceRegistryEntry(params.serviceId);
    if (!entry.service || !entry.legacyServiceId) return null;
    return {
        service: entry.service,
        legacyServiceId: entry.legacyServiceId,
        serviceLabel: resolveConnectedServiceRegistryEntryDisplayName(entry, t, params.localizePluginText),
        profileId: params.profileId,
        profileLabel: resolveConnectedServiceProfileLabel({
            labelsByKey: params.settings.connectedServicesProfileLabelByKey,
            serviceId: entry.legacyServiceId,
            profileId: params.profileId,
        }),
    };
}

export function useConnectedServiceQuotaSummaries(): Readonly<{
    summaries: ReadonlyArray<ConnectedServiceQuotaSummary>;
    isRefreshing: boolean;
    hasConnectedProfiles: boolean;
}> {
    const quotasEnabled = useFeatureEnabled('connectedServices.quotas');
    const profile = useProfile();
    const settings = useSettings();
    const connectedServicesRegistrySnapshot = useProjectedConnectedServicesRegistry();
    const localizePluginText = useProjectedPluginLocalizedTextResolver();
    const serverFeatures = useServerFeaturesRuntimeSnapshot({
        enabled: quotasEnabled,
    });
    const accountTransport = resolveConnectedAccountUiNegotiation(serverFeatures);

    const quotaProfileInputs = React.useMemo<ConnectedServiceQuotaProfileRefInput[]>(() => {
        if (!quotasEnabled) {
            return [];
        }

        if (accountTransport === 'advertised-v4') {
            return profile.connectedAccountsV4.flatMap((account) => (
                // Usage DISPLAY fails OPEN: skip an account ONLY for an explicit,
                // recognized needs_reauth. Absent/unknown status still shows usage.
                shouldHideQuotaForCredentialStatus(account.status)
                    ? []
                    : [{ ref: account.ref }]
            ));
        }

        // A failed/in-flight V4 capability probe has no safe scalar transport.
        // Only a proven legacy peer may enter through the generated adapter.
        if (accountTransport !== 'legacy') return [];

        const next: ConnectedServiceQuotaProfileRefInput[] = [];
        for (const service of profile.connectedServicesV2) {
            const compatibility = getLegacyConnectedServiceRegistryEntry(service.serviceId);
            if (!compatibility.service || !compatibility.legacyServiceId) continue;
            for (const entry of service.profiles ?? []) {
                // Usage DISPLAY fails OPEN: skip a profile ONLY for an explicit,
                // recognized needs_reauth. Absent/unknown/'' status still shows
                // usage (single predicate shared with every quota gate).
                if (shouldHideQuotaForCredentialStatus(entry.status)) {
                    continue;
                }
                next.push({
                    serviceId: compatibility.legacyServiceId,
                    profileId: entry.profileId,
                });
            }
        }
        return next;
    }, [
        accountTransport,
        profile.connectedAccountsV4,
        profile.connectedServicesV2,
        quotasEnabled,
    ]);

    const {
        profiles: connectedProfiles,
        snapshotsByKey,
        loadingByKey,
    } = useConnectedServiceQuotaSnapshots(quotaProfileInputs);

    const summaries = React.useMemo(() => {
        if (!quotasEnabled) {
            return [] as ConnectedServiceQuotaSummary[];
        }

        const next: ConnectedServiceQuotaSummary[] = [];
        for (const entry of connectedProfiles) {
            const summaryService = entry.kind === 'qualified'
                ? resolveQualifiedSummaryService({
                    ref: entry.ref,
                    settings,
                    registryEntries: connectedServicesRegistrySnapshot.entries,
                    localizePluginText,
                })
                : resolveLegacySummaryService({
                    serviceId: entry.serviceId,
                    profileId: entry.profileId,
                    settings,
                    localizePluginText,
                });
            if (!summaryService) continue;
            const snapshot = snapshotsByKey[entry.key];
            if (!snapshot || snapshot.meters.length === 0) {
                continue;
            }

            const pinnedMeterIds = settings.connectedServicesQuotaPinnedMeterIdsByKey[entry.key] ?? [];
            const rawStrategy = settings.connectedServicesQuotaSummaryStrategyByKey[entry.key];
            const strategy = rawStrategy === 'min_remaining' ? 'min_remaining' : 'primary';
            const meters = buildSummaryMeters(snapshot.meters, pinnedMeterIds, strategy);

            next.push({
                key: entry.key,
                ...summaryService,
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
            const serviceOrder = left.serviceLabel.localeCompare(right.serviceLabel);
            return serviceOrder !== 0
                ? serviceOrder
                : left.key.localeCompare(right.key);
        });
    }, [
        connectedServicesRegistrySnapshot,
        connectedProfiles,
        quotasEnabled,
        localizePluginText,
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
