import * as React from 'react';
import { useShallow } from 'zustand/react/shallow';
import { storage } from '@/sync/domains/state/storage';
import type { AccountProfile, ConnectedServiceQuotaRecoveryCreditsV1 } from '@happier-dev/protocol';

import { resolveDefaultProviderUsageProfileRef } from '@/components/sessions/usage/resolveDefaultProviderUsageProfileRef';
import { selectProviderUsageDisplaySnapshot, type ProviderUsageDisplayConnectedServiceProfileRef } from '@/sync/domains/connectedServices/accountUsage/selectors';
import { selectConnectedServiceSessionProviderUsageGaugeSource } from '@/sync/domains/connectedServices/connectedServiceQuotaGauge';
import { connectedServiceProfileKey } from '@/sync/domains/connectedServices/connectedServiceProfilePreferences';
import { selectProviderUsageRecordIds, selectProviderUsageRuntimeIssuesForAccounts } from '@/sync/store/hooks';
import { useConnectedServiceQuotaSnapshots } from './useConnectedServiceQuotaSnapshots';
import { useProviderAccountUsageSnapshots } from './useProviderAccountUsageSnapshots';

type UsageRequest = Readonly<{
    providerId: string | null;
    profileRef?: (ProviderUsageDisplayConnectedServiceProfileRef & { groupId?: string }) | null;
    metadataRecordIds?: readonly string[];
    nativeAccount?: boolean;
    /** The session asking; evidence for an unidentified account stays with it. */
    sessionId?: string | null;
    sessionCheckNowSupported?: boolean;
    recoveryCredits?: ConnectedServiceQuotaRecoveryCreditsV1 | null;
}>;

/**
 * Account usage has one read owner. HUD, picker and composers supply account identity;
 * they never choose between session failures, native observations and connected quotas.
 * Fetch demand controls network work, not access to already observed usage.
 */
export function useProviderUsageSources(params: Readonly<{
    requests: readonly UsageRequest[];
    connectedServices: ReadonlyArray<AccountProfile['connectedServicesV2'][number]>;
    fetchEnabled: boolean;
}>) {
    const knownRecordIds = storage(useShallow(state => selectProviderUsageRecordIds(state.sessions)));
    const targets = React.useMemo(() => params.requests.map((request) => {
        const defaultRef = resolveDefaultProviderUsageProfileRef({
            agentId: request.providerId, connectedServices: params.connectedServices,
        });
        // The default account is a connected login like an explicit binding: its usage comes only
        // from its own quota snapshot, never from another account's native usage records.
        const profileRef = request.profileRef ?? (defaultRef && !request.nativeAccount && !request.metadataRecordIds?.length
            ? { ...defaultRef, provenance: 'connected_binding_profile' as const } : null);
        return { ...request, profileRef };
    }), [params.requests, params.connectedServices]);
    const profiles = React.useMemo(() => targets.flatMap(target => target.profileRef ? [target.profileRef] : []), [targets]);
    const quotaViews = useConnectedServiceQuotaSnapshots(profiles, {
        fetchPolicy: params.fetchEnabled ? 'poll' : 'cache_only',
    });
    const recordIds = React.useMemo(() => [...new Set([
        ...knownRecordIds,
        ...targets.flatMap(target => target.metadataRecordIds ?? []),
    ])], [knownRecordIds, targets]);
    const nativeViews = useProviderAccountUsageSnapshots(recordIds, { fetchEnabled: params.fetchEnabled });
    const runtimeIssues = storage(useShallow(state => selectProviderUsageRuntimeIssuesForAccounts(state.sessions, targets)));

    return React.useMemo(() => targets.map((target, index) => {
        const profileKey = target.profileRef ? connectedServiceProfileKey(target.profileRef) : null;
        const quotaDisplaySnapshot = profileKey ? quotaViews.snapshotsByKey[profileKey] ?? null : null;
        const displaySnapshotSource = selectProviderUsageDisplaySnapshot({
            providerId: target.providerId,
            // Explicit native record ids select an account, rather than a session-local copy
            // of its figures. Every reader observes the same shared cache for that record.
            metadataRecordIds: target.metadataRecordIds?.length ? target.metadataRecordIds : recordIds,
            accountUsageSnapshotsByRecordId: nativeViews,
            connectedServiceProfileRef: target.profileRef,
            connectedServiceQuotaView: quotaDisplaySnapshot,
        });
        const gaugeSource = selectConnectedServiceSessionProviderUsageGaugeSource({
            providerId: target.providerId,
            connectedServiceSnapshot: displaySnapshotSource?.snapshot ?? null,
            connectedServiceRefProvenance: displaySnapshotSource?.connectedServiceRefProvenance,
            runtimeIssue: runtimeIssues[index],
            sessionCheckNowSupported: target.sessionCheckNowSupported,
            recoveryCredits: target.recoveryCredits,
        });
        return { profileRef: target.profileRef, profileKey, quotaDisplaySnapshot,
            displaySnapshotSource, gaugeSource, recordIds };
    }), [targets, quotaViews.snapshotsByKey, nativeViews, runtimeIssues, recordIds]);
}
