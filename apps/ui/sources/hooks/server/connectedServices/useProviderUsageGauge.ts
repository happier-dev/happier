import * as React from 'react';

import {
    ConnectedServiceIdSchema,
    isConnectedServiceCredentialHealthStatusUsable,
    type ConnectedServiceQuotaRecoveryCreditsV1,
    type SessionRuntimeIssueV1,
} from '@happier-dev/protocol';

import { resolveConnectedServiceDisplayName } from '@/components/settings/connectedServices/model/resolveConnectedServiceDisplayName';
import { connectedServiceQuotaGaugeFormatter } from '@/components/sessions/usage/connectedServiceQuotaGaugeFormatter';
import { useConnectedServiceAuthGroupsQuery } from '@/hooks/server/connectedServices/useConnectedServiceAuthGroupsQuery';
import { useConnectedServiceQuotaSnapshots } from '@/hooks/server/connectedServices/useConnectedServiceQuotaSnapshots';
import { useProviderAccountUsageSnapshots } from '@/hooks/server/connectedServices/useProviderAccountUsageSnapshots';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import {
    selectProviderUsageDisplaySnapshot,
    type ProviderUsageDisplaySnapshotSource,
} from '@/sync/domains/connectedServices/accountUsage/selectors';
import {
    computeConnectedServiceQuotaGaugeViewModel,
    selectConnectedServiceSessionProviderUsageGaugeSource,
    type ConnectedServiceQuotaGaugeSource,
    type ConnectedServiceQuotaGaugeViewModel,
    type ConnectedServiceQuotaGaugeWindowMode,
    type ConnectedServiceQuotaProfileRefProvenance,
} from '@/sync/domains/connectedServices/connectedServiceQuotaGauge';
import {
    connectedServiceProfileKey,
    resolveConnectedServiceProfileLabel,
} from '@/sync/domains/connectedServices/connectedServiceProfilePreferences';
import { resolveConnectedServiceCredentialHealthStatus } from '@/sync/domains/connectedServices/resolveConnectedServiceCredentialHealthStatus';
import { resolveConnectedServiceProjectionSignature } from '@/sync/domains/connectedServices/resolveConnectedServiceProjectionSignature';
import { useProfile, useSetting } from '@/sync/domains/state/storage';
import { nowServerMs } from '@/sync/runtime/time';
import { t } from '@/text';

export type ProviderUsageGaugeProfileRef = Readonly<{
    serviceId: string;
    profileId: string;
    groupId?: string;
    credentialHealthStatus?: unknown;
    provenance: ConnectedServiceQuotaProfileRefProvenance;
}>;

export type ProviderUsageGaugeResult = Readonly<{
    gauge: ConnectedServiceQuotaGaugeViewModel | null;
    gaugeSource: ConnectedServiceQuotaGaugeSource | null;
    displaySnapshotSource: ProviderUsageDisplaySnapshotSource | null;
    profileKey: string | null;
    windowMode: ConnectedServiceQuotaGaugeWindowMode;
}>;

const EMPTY_RECORD_IDS: readonly string[] = [];

function resolveConnectedServiceProviderDisplayName(serviceId: string): string | null {
    const parsed = ConnectedServiceIdSchema.safeParse(serviceId);
    if (!parsed.success) return null;
    return resolveConnectedServiceDisplayName(parsed.data, t);
}

/**
 * Single composer-facing owner of the provider usage (quota) gauge. The session composer and the
 * new-session composer both read it, so the gauge visibility setting, window modes, pinned meters,
 * account-group limit selection and the "no fake gauges" source rules apply identically to both.
 * Session-only evidence (usage record ids, runtime issues, recovery credits) is optional input.
 */
export function useProviderUsageGauge(params: Readonly<{
    providerId: string | null;
    profileRef: ProviderUsageGaugeProfileRef | null;
    modelId: string | null;
    metadataRecordIds?: readonly string[];
    runtimeIssue?: SessionRuntimeIssueV1 | null;
    sessionCheckNowSupported?: boolean;
    recoveryCredits?: ConnectedServiceQuotaRecoveryCreditsV1 | null;
}>): ProviderUsageGaugeResult {
    const profileRef = params.profileRef;
    const metadataRecordIds = params.metadataRecordIds ?? EMPTY_RECORD_IDS;
    const accountProfile = useProfile();
    const connectedServiceQuotasEnabled = useFeatureEnabled('connectedServices.quotas');
    const windowModesSetting = useSetting('sessionProviderUsageGaugeWindowModes');
    const pinnedQuotaMeterIdsByKey = useSetting('connectedServicesQuotaPinnedMeterIdsByKey');
    const gaugeMode = useSetting('sessionProviderUsageGaugeMode');
    const windowModeSetting = useSetting('sessionProviderUsageGaugeWindowMode');
    const profileLabelByKey = useSetting('connectedServicesProfileLabelByKey');
    const windowMode: ConnectedServiceQuotaGaugeWindowMode =
        windowModeSetting === 'daily'
        || windowModeSetting === 'weekly'
        || windowModeSetting === 'primary'
        || windowModeSetting === 'secondary'
        || windowModeSetting === 'session'
            ? windowModeSetting
            : 'most_constrained';

    const groupService = React.useMemo(() => (
        profileRef?.groupId
            ? accountProfile?.connectedServicesV2.find((service) => service.serviceId === profileRef.serviceId) ?? null
            : null
    ), [accountProfile?.connectedServicesV2, profileRef]);
    const groupServiceId = React.useMemo(() => {
        if (!profileRef?.groupId) return null;
        const parsed = ConnectedServiceIdSchema.safeParse(profileRef.serviceId);
        return parsed.success ? parsed.data : null;
    }, [profileRef]);
    const authGroups = useConnectedServiceAuthGroupsQuery({
        serviceId: groupServiceId,
        enabled: groupServiceId !== null,
        serviceProjectionSignature: resolveConnectedServiceProjectionSignature(groupService),
    });
    const quotaLimitSelection = React.useMemo(() => {
        if (!profileRef?.groupId) return undefined;
        const group = authGroups.groups.find((candidate) => candidate.groupId === profileRef.groupId);
        return group ? group.policy.quotaLimitSelection : null;
    }, [authGroups.groups, profileRef?.groupId]);

    const credentialUsable = React.useMemo(() => {
        if (profileRef?.credentialHealthStatus === undefined) return true;
        return isConnectedServiceCredentialHealthStatusUsable(
            resolveConnectedServiceCredentialHealthStatus(profileRef.credentialHealthStatus),
        );
    }, [profileRef?.credentialHealthStatus]);
    const quotaSnapshots = useConnectedServiceQuotaSnapshots(profileRef ? [profileRef] : []);
    const profileKey = profileRef ? connectedServiceProfileKey(profileRef) : null;
    const quotaDisplaySnapshot = profileKey ? quotaSnapshots.snapshotsByKey[profileKey] ?? null : null;
    const accountUsageSnapshotsByRecordId = useProviderAccountUsageSnapshots(metadataRecordIds);
    const activeAccountLabel = React.useMemo(() => {
        if (!profileRef) return quotaDisplaySnapshot?.accountLabel ?? null;
        return resolveConnectedServiceProfileLabel({
            labelsByKey: profileLabelByKey,
            serviceId: profileRef.serviceId,
            profileId: profileRef.profileId,
        }) ?? quotaDisplaySnapshot?.accountLabel ?? profileRef.profileId;
    }, [profileRef, quotaDisplaySnapshot?.accountLabel, profileLabelByKey]);
    const displaySnapshotSource = React.useMemo(() => (
        selectProviderUsageDisplaySnapshot({
            providerId: params.providerId,
            metadataRecordIds,
            accountUsageSnapshotsByRecordId,
            connectedServiceProfileRef: profileRef,
            connectedServiceQuotaView: quotaDisplaySnapshot,
        })
    ), [accountUsageSnapshotsByRecordId, metadataRecordIds, params.providerId, profileRef, quotaDisplaySnapshot]);
    const gaugeSource = React.useMemo(() => {
        if (!connectedServiceQuotasEnabled || gaugeMode === 'hidden') return null;
        if (!credentialUsable) return null;
        return selectConnectedServiceSessionProviderUsageGaugeSource({
            providerId: params.providerId,
            connectedServiceSnapshot: displaySnapshotSource?.snapshot ?? null,
            connectedServiceRefProvenance: displaySnapshotSource?.connectedServiceRefProvenance ?? null,
            sessionCheckNowSupported: params.sessionCheckNowSupported,
            recoveryCredits: params.recoveryCredits,
            runtimeIssue: params.runtimeIssue ?? null,
            nowMs: nowServerMs(),
        });
    }, [
        connectedServiceQuotasEnabled,
        credentialUsable,
        displaySnapshotSource,
        gaugeMode,
        params.providerId,
        params.recoveryCredits,
        params.runtimeIssue,
        params.sessionCheckNowSupported,
    ]);
    const gauge = React.useMemo(() => {
        if (!gaugeSource) return null;
        return computeConnectedServiceQuotaGaugeViewModel({
            snapshot: gaugeSource.snapshot,
            activeModelId: params.modelId,
            windowMode,
            windowModes: windowModesSetting,
            additionalMeterIds: profileRef && gaugeSource.snapshot.serviceId === profileRef.serviceId
                ? pinnedQuotaMeterIdsByKey[connectedServiceProfileKey(gaugeSource.snapshot)] ?? []
                : [],
            quotaLimitSelection,
            nowMs: nowServerMs(),
            formatter: connectedServiceQuotaGaugeFormatter,
            providerDisplayName: resolveConnectedServiceProviderDisplayName(gaugeSource.snapshot.serviceId),
            activeAccountDisplayLabel: displaySnapshotSource?.kind === 'connected_service_quota_view'
                && gaugeSource.snapshot === quotaDisplaySnapshot
                ? activeAccountLabel
                : gaugeSource.snapshot.accountLabel ?? null,
        });
    }, [
        activeAccountLabel,
        displaySnapshotSource?.kind,
        gaugeSource,
        params.modelId,
        pinnedQuotaMeterIdsByKey,
        profileRef,
        quotaDisplaySnapshot,
        quotaLimitSelection,
        windowMode,
        windowModesSetting,
    ]);

    return React.useMemo(() => ({
        gauge,
        gaugeSource,
        displaySnapshotSource,
        profileKey,
        windowMode,
    }), [displaySnapshotSource, gauge, gaugeSource, profileKey, windowMode]);
}
