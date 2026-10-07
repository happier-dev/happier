import * as React from 'react';

import {
    useProjectedPluginLocalizedTextResolver,
    useProjectedConnectedServicesRegistry,
} from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { t } from '@/text';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useProfile, useSettingsSelector } from '@/sync/store/hooks';
import type { Settings } from '@/sync/domains/settings/settings';
import {
    connectedServiceProfileKey,
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
    buildSummaryMeters,
    type ConnectedServiceQuotaSummaryMeter,
    type ConnectedServiceQuotaSummaryStrategy,
} from '@/sync/domains/connectedServices/connectedServiceQuotaBadges';
import { shouldHideQuotaForCredentialStatus } from '@/sync/domains/connectedServices/shouldHideQuotaForCredentialStatus';
import { buildQualifiedPluginContributionKey, type PluginContributionIdentityV1 } from '@happier-dev/protocol/plugins/contribution-identity';
import type { ConnectedServiceId } from '@happier-dev/protocol/connect/connected-service-bindings';
import type { ConnectedServiceQuotaRecoveryCreditsV1 } from '@happier-dev/protocol/connect/connected-service-schemas';
import type { ProviderAccountUsageRecordId } from '@happier-dev/protocol/connect/account-usage-primitives';

import {
    useConnectedServiceQuotaSnapshots,
    type ConnectedServiceQuotaSnapshotsFetchPolicy,
} from './useConnectedServiceQuotaSnapshots';
import type {
    ConnectedServiceQuotaProfileRefInput,
} from '@/sync/domains/connectedServices/connectedServiceQuotaProfileRefs';
import {
    resolveConnectedServiceRegistryEntryDisplayName,
    resolveQualifiedConnectedServiceRegistryEntry,
} from '@/components/settings/connectedServices/model/resolveConnectedServiceDisplayName';
import {
    type PluginLocalizedTextResolver,
} from '@/sync/domains/plugins/ui/i18n';

export { buildSummaryMeters, type ConnectedServiceQuotaSummaryMeter } from '@/sync/domains/connectedServices/connectedServiceQuotaBadges';

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
    /** When the server read this snapshot (epoch ms), for an honest "as of". */
    fetchedAt: number;
    /** The account's usage resets (Codex), as this read reported them; null when it has none. */
    recoveryCredits: ConnectedServiceQuotaRecoveryCreditsV1 | null;
} & ConnectedServiceQuotaAccountIdentity>;

/**
 * Who a connected account is, for people, and which provider it belongs to. The fields are carried as
 * they are: every surface renders them through the one identity presenter
 * (`useConnectedAccountIdentityPrivacy().present`), which applies "Hide account emails and IDs".
 */
export type ConnectedServiceQuotaAccountIdentity = Readonly<{
    /** Groups one provider's accounts (the service's `pluginId/localId`). */
    serviceGroupKey: string;
    /** The name someone gave the account in Happier, else its display name; null when it has neither. */
    accountLabel: string | null;
    /** The provider's email for the account, when it reports one. */
    accountEmail: string | null;
    accountId: string;
}>;

/** A connected account with no usage to show: its read is still running, or it answered without any. */
export type ConnectedServiceAccountWithoutUsage = Readonly<{
    key: string;
    serviceLabel: string;
    legacyServiceId: ConnectedServiceId | null;
    state: 'loading' | 'unavailable';
} & ConnectedServiceQuotaAccountIdentity>;

/** A connected account that needs a new sign-in: no usage is read for it until it signs in again. */
export type ConnectedServiceAccountNeedingSignIn = Readonly<{
    key: string;
    ref: Readonly<{ service: PluginContributionIdentityV1; accountId: string }>;
    serviceLabel: string;
    legacyServiceId: ConnectedServiceId | null;
} & ConnectedServiceQuotaAccountIdentity>;

function resolveQualifiedSummaryService(params: Readonly<{
    ref: Readonly<{ service: PluginContributionIdentityV1; accountId: string }>;
    settings: Pick<Settings, 'connectedServicesProfileLabelByKey'>;
    registryEntries: readonly ConnectedServiceRegistryEntry[];
    localizePluginText: PluginLocalizedTextResolver;
}>): Readonly<{
    service: PluginContributionIdentityV1;
    legacyServiceId: ConnectedServiceId | null;
    serviceLabel: string;
    profileId: string;
    profileLabel: string | null;
}> {
    const entry = resolveQualifiedConnectedServiceRegistryEntry({ entries: params.registryEntries }, params.ref.service);
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
    settings: Pick<Settings, 'connectedServicesProfileLabelByKey'>;
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

function resolveAccountIdentity(input: Readonly<{
    serviceGroupKey: string;
    profileLabel: string | null;
    displayName?: string | null;
    email?: string | null;
    accountId: string;
}>): ConnectedServiceQuotaAccountIdentity {
    return {
        serviceGroupKey: input.serviceGroupKey,
        accountLabel: input.profileLabel?.trim() || input.displayName?.trim() || null,
        accountEmail: input.email?.trim() || null,
        accountId: input.accountId,
    };
}

/** The account's chosen summary strategy; anything unrecognised reads as the primary meter. */
export function resolveQuotaSummaryStrategy(raw: unknown): ConnectedServiceQuotaSummaryStrategy {
    return raw === 'min_remaining' ? 'min_remaining' : 'primary';
}

export function useConnectedServiceQuotaSummaries(options?: Readonly<{
    /** `cache_only`: summarise what this launch already read; never start a read (a hub). */
    fetchPolicy?: ConnectedServiceQuotaSnapshotsFetchPolicy;
}>): Readonly<{
    summaries: ReadonlyArray<ConnectedServiceQuotaSummary>;
    /**
     * Connected accounts with no usage to show, each with why. A `cache_only` read claims nothing
     * about an account it has not read.
     */
    accountsWithoutUsage: ReadonlyArray<ConnectedServiceAccountWithoutUsage>;
    /** Accounts that need a new sign-in (their usage is not read), for the fix beside usage. */
    accountsNeedingSignIn: ReadonlyArray<ConnectedServiceAccountNeedingSignIn>;
    /** Keys and tokens that answered without any limit: counted, never listed as "unavailable". */
    keysWithoutLimits: number;
    /** Accounts a pool is using right now (summary keys). */
    inUseAccountKeys: ReadonlySet<string>;
    /**
     * Each read account's provider-account usage record (summary key → record id), the server-minted
     * binding to its subscription and usage resets (`useProviderAccountUsageSnapshots`); null on the
     * legacy transport.
     */
    usageRecordIdsByKey: Readonly<Record<string, ProviderAccountUsageRecordId | null>>;
    isRefreshing: boolean;
    hasConnectedProfiles: boolean;
    refreshableKeys: readonly string[];
    refreshingByKey: Readonly<Record<string, boolean>>;
    errorsByKey: Readonly<Record<string, string | null>>;
    refresh(keys?: readonly string[]): Promise<void>;
}> {
    const quotasEnabled = useFeatureEnabled('connectedServices.quotas');
    const profile = useProfile();
    const settings = useSettingsSelector((settings) => ({
        connectedServicesQuotaPinnedMeterIdsByKey: settings.connectedServicesQuotaPinnedMeterIdsByKey,
        connectedServicesQuotaSummaryStrategyByKey: settings.connectedServicesQuotaSummaryStrategyByKey,
        connectedServicesProfileLabelByKey: settings.connectedServicesProfileLabelByKey,
    }));
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
        readByKey,
        usageRecordIdsByKey,
        refreshableKeys,
        refreshingByKey,
        errorsByKey,
        refresh,
    } = useConnectedServiceQuotaSnapshots(quotaProfileInputs, { fetchPolicy: options?.fetchPolicy });
    const readsAccounts = (options?.fetchPolicy ?? 'poll') !== 'cache_only';

    const { summaries, accountsWithoutUsage, keysWithoutLimits } = React.useMemo(() => {
        if (!quotasEnabled) {
            return {
                summaries: [] as ConnectedServiceQuotaSummary[],
                accountsWithoutUsage: [] as ConnectedServiceAccountWithoutUsage[],
                keysWithoutLimits: 0,
            };
        }

        const next: ConnectedServiceQuotaSummary[] = [];
        const withoutUsage: ConnectedServiceAccountWithoutUsage[] = [];
        let keysWithoutLimits = 0;
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
            const presentation = entry.kind === 'qualified'
                ? profile.connectedAccountsV4.find((account) => (
                    account.ref.service.pluginId === entry.ref.service.pluginId
                    && account.ref.service.localId === entry.ref.service.localId
                    && account.ref.accountId === entry.ref.accountId
                ))
                : undefined;
            const legacyProfile = entry.kind === 'qualified'
                ? undefined
                : profile.connectedServicesV2
                    .find((service) => service.serviceId === entry.serviceId)
                    ?.profiles?.find((candidate) => candidate.profileId === entry.profileId);
            const identity = resolveAccountIdentity({
                serviceGroupKey: `${summaryService.service.pluginId}/${summaryService.service.localId}`,
                profileLabel: summaryService.profileLabel,
                displayName: presentation?.displayName ?? null,
                email: presentation?.providerIdentity?.email ?? legacyProfile?.providerEmail ?? null,
                accountId: summaryService.profileId,
            });
            const snapshot = snapshotsByKey[entry.key];
            if (!snapshot || snapshot.meters.length === 0) {
                // In flight (or not started yet) reads as loading; a finished read without usage is
                // unavailable. A cache-only reader says nothing about an account it did not read.
                const read = readByKey[entry.key] === true && loadingByKey[entry.key] !== true;
                // A key that answered without limits reports none by design: counted, not "unavailable".
                if (read && presentation?.kind === 'token') {
                    keysWithoutLimits += 1;
                    continue;
                }
                if (readsAccounts || read) {
                    withoutUsage.push({
                        key: entry.key,
                        serviceLabel: summaryService.serviceLabel,
                        legacyServiceId: summaryService.legacyServiceId,
                        state: read ? 'unavailable' : 'loading',
                        ...identity,
                    });
                }
                continue;
            }

            const pinnedMeterIds = settings.connectedServicesQuotaPinnedMeterIdsByKey[entry.key] ?? [];
            const strategy = resolveQuotaSummaryStrategy(settings.connectedServicesQuotaSummaryStrategyByKey[entry.key]);
            const meters = buildSummaryMeters(snapshot.meters, pinnedMeterIds, strategy);
            if (meters.length === 0) {
                withoutUsage.push({
                    key: entry.key, serviceLabel: summaryService.serviceLabel,
                    legacyServiceId: summaryService.legacyServiceId, state: 'unavailable', ...identity,
                });
                continue;
            }

            next.push({
                key: entry.key,
                ...summaryService,
                ...identity,
                planLabel: snapshot.planLabel,
                primaryMeter: meters[0] ?? null,
                meters,
                fetchedAt: snapshot.fetchedAt,
                recoveryCredits: snapshot.recoveryCredits ?? null,
            });
        }

        return {
            summaries: next.sort((left, right) => {
                const leftScore = left.primaryMeter?.remainingPct ?? Number.POSITIVE_INFINITY;
                const rightScore = right.primaryMeter?.remainingPct ?? Number.POSITIVE_INFINITY;
                if (leftScore !== rightScore) {
                    return leftScore - rightScore;
                }
                const serviceOrder = left.serviceLabel.localeCompare(right.serviceLabel);
                return serviceOrder !== 0
                    ? serviceOrder
                    : left.key.localeCompare(right.key);
            }),
            accountsWithoutUsage: withoutUsage,
            keysWithoutLimits,
        };
    }, [
        connectedServicesRegistrySnapshot,
        connectedProfiles,
        quotasEnabled,
        localizePluginText,
        loadingByKey,
        profile.connectedAccountsV4,
        profile.connectedServicesV2,
        readByKey,
        readsAccounts,
        settings.connectedServicesProfileLabelByKey,
        settings.connectedServicesQuotaPinnedMeterIdsByKey,
        settings.connectedServicesQuotaSummaryStrategyByKey,
        snapshotsByKey,
    ]);

    const isRefreshing = React.useMemo(
        () => Object.values(loadingByKey).some(Boolean) || Object.values(refreshingByKey).some(Boolean),
        [loadingByKey, refreshingByKey],
    );

    // Signed-out accounts are not read (their usage is hidden) but still belong beside usage, with
    // their fix. V4 accounts only: the released V2 projection names its services through the adapter.
    const accountsNeedingSignIn = React.useMemo((): ConnectedServiceAccountNeedingSignIn[] => {
        if (accountTransport !== 'advertised-v4') return [];
        return profile.connectedAccountsV4.flatMap((account) => {
            if (!shouldHideQuotaForCredentialStatus(account.status)) return [];
            const summaryService = resolveQualifiedSummaryService({
                ref: account.ref,
                settings,
                registryEntries: connectedServicesRegistrySnapshot.entries,
                localizePluginText,
            });
            return [{
                key: connectedServiceProfileKey({
                    serviceId: buildQualifiedPluginContributionKey(account.ref.service),
                    profileId: account.ref.accountId,
                }),
                ref: account.ref,
                serviceLabel: summaryService.serviceLabel,
                legacyServiceId: summaryService.legacyServiceId,
                ...resolveAccountIdentity({
                    serviceGroupKey: `${account.ref.service.pluginId}/${account.ref.service.localId}`,
                    profileLabel: summaryService.profileLabel,
                    displayName: account.displayName ?? null,
                    email: account.providerIdentity?.email ?? null,
                    accountId: account.ref.accountId,
                }),
            }];
        });
    }, [accountTransport, connectedServicesRegistrySnapshot.entries, localizePluginText, profile.connectedAccountsV4, settings]);

    const groups = (profile as { connectedAccountGroupsV4?: ReadonlyArray<Readonly<{
        ref: Readonly<{ service: PluginContributionIdentityV1 }>;
        activeConnectedAccountId: string | null;
    }>> }).connectedAccountGroupsV4;
    const inUseAccountKeys = React.useMemo(() => new Set((groups ?? []).flatMap((group) => (
        group.activeConnectedAccountId
            ? [connectedServiceProfileKey({
                serviceId: buildQualifiedPluginContributionKey(group.ref.service),
                profileId: group.activeConnectedAccountId,
            })]
            : []
    ))), [groups]);

    return {
        summaries,
        accountsWithoutUsage,
        accountsNeedingSignIn,
        keysWithoutLimits,
        inUseAccountKeys,
        usageRecordIdsByKey,
        isRefreshing,
        hasConnectedProfiles: connectedProfiles.length > 0,
        refreshableKeys,
        refreshingByKey,
        errorsByKey,
        refresh,
    };
}
