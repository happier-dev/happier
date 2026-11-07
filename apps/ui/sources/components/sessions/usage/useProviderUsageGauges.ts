import * as React from 'react';
import type { AccountProfile } from '@happier-dev/protocol';
import {
    isConnectedServiceCredentialHealthStatusUsable,
} from '@happier-dev/protocol';

import { getAgentCore, type AgentId } from '@/agents/catalog/catalog';
import { connectedServiceQuotaGaugeFormatter } from '@/components/sessions/usage/connectedServiceQuotaGaugeFormatter';
import { useConnectedServiceQuotaSnapshots } from '@/hooks/server/connectedServices/useConnectedServiceQuotaSnapshots';
import { runProviderUsageRefresh, useProviderUsageRefreshContext } from '@/hooks/server/connectedServices/useProviderUsageRefresh';
import { useProviderAccountUsageSnapshots } from '@/hooks/server/connectedServices/useProviderAccountUsageSnapshots';
import { selectProviderUsageDisplaySnapshot } from '@/sync/domains/connectedServices/accountUsage/selectors';
import {
    computeConnectedServiceQuotaGaugeViewModel,
    selectConnectedServiceSessionProviderUsageGaugeSource,
    type ConnectedServiceQuotaGaugeViewModel,
    type ConnectedServiceQuotaGaugeWindowMode,
} from '@/sync/domains/connectedServices/connectedServiceQuotaGauge';
import { connectedServiceProfileKey } from '@/sync/domains/connectedServices/connectedServiceProfilePreferences';
import { resolveConnectedServiceCredentialHealthStatus } from '@/sync/domains/connectedServices/resolveConnectedServiceCredentialHealthStatus';
import { nowServerMs } from '@/sync/runtime/time';
import { useSetting } from '@/sync/domains/state/storage';
import { useLatestProviderUsageRecordIdsByAgent, useLatestProviderUsageRuntimeIssuesByAgent } from '@/sync/store/hooks';
import { t } from '@/text';

type AccountProfileConnectedService = AccountProfile['connectedServicesV2'][number];

/**
 * Usage gauge per Agent, for surfaces that show every configured provider at once (the
 * sessions pane header and the Agent picker rail).
 *
 * Two sources, through the same selector the composer uses: a usable connected-service
 * profile's quota, else the provider account usage the Agent's most recent session
 * recorded for the native login. An Agent with neither has no entry.
 */
export function useProviderUsageGauges(params: Readonly<{
    agentIds: readonly AgentId[];
    accountProfileConnectedServicesV2: ReadonlyArray<AccountProfileConnectedService>;
    windowMode: ConnectedServiceQuotaGaugeWindowMode;
    /** Usage is only fetched while a surface wants it; until then only cached values render. */
    fetchEnabled: boolean;
}>): Readonly<{
    gauges: ReadonlyMap<AgentId, ConnectedServiceQuotaGaugeViewModel>;
    /** Configured profiles or native logins remain present even when credential health prevents querying. */
    configuredAgentIds: ReadonlySet<AgentId>;
    /** Queries every configured provider, including this Agent's displayed account. */
    refreshAgent: (agentId: AgentId) => void;
}> {
    const windowModes = useSetting('sessionProviderUsageGaugeWindowModes');
    const profileRefByAgentId = React.useMemo(() => {
        const refs = new Map<AgentId, { serviceId: string; profileId: string }>();
        for (const agentId of params.agentIds) {
            const supportedServiceIds = getAgentCore(agentId).connectedServices?.supportedServiceIds ?? [];
            for (const serviceId of supportedServiceIds) {
                const service = params.accountProfileConnectedServicesV2.find((candidate) => candidate.serviceId === serviceId);
                const profile = service?.profiles.find((candidate) => (
                    candidate.profileId.trim().length > 0
                    && isConnectedServiceCredentialHealthStatusUsable(resolveConnectedServiceCredentialHealthStatus(candidate.status))
                ));
                if (!profile) continue;
                refs.set(agentId, { serviceId, profileId: profile.profileId.trim() });
                break;
            }
        }
        return refs;
    }, [params.accountProfileConnectedServicesV2, params.agentIds]);
    const profileRefs = React.useMemo(() => [...profileRefByAgentId.values()], [profileRefByAgentId]);
    const quotaSnapshots = useConnectedServiceQuotaSnapshots(profileRefs, {
        fetchPolicy: params.fetchEnabled ? 'poll' : 'cache_only',
    });

    // The most recent session per Agent that recorded usage refs speaks for that Agent's login.
    const latestRecordIdsByAgent = useLatestProviderUsageRecordIdsByAgent();
    const latestRuntimeIssuesByAgent = useLatestProviderUsageRuntimeIssuesByAgent();
    const recordIdsByAgentId = React.useMemo(() => {
        const wanted = new Set<string>(params.agentIds);
        return new Map([...latestRecordIdsByAgent].filter(([agentId]) => wanted.has(agentId)));
    }, [params.agentIds, latestRecordIdsByAgent]);
    const allRecordIds = React.useMemo(
        () => params.fetchEnabled ? [...latestRecordIdsByAgent.values()].flat() : [],
        [params.fetchEnabled, latestRecordIdsByAgent],
    );
    const accountUsageSnapshots = useProviderAccountUsageSnapshots(allRecordIds);

    const refreshContext = useProviderUsageRefreshContext();
    const refreshAgent = React.useCallback((agentId: AgentId) => {
        if (!refreshContext) return;
        runProviderUsageRefresh(refreshContext, {
            connectedProfileRef: profileRefByAgentId.get(agentId) ?? null,
            recordIds: recordIdsByAgentId.get(agentId) ?? [],
        });
    }, [profileRefByAgentId, recordIdsByAgentId, refreshContext]);

    const gauges = React.useMemo(() => {
        const gauges = new Map<AgentId, ConnectedServiceQuotaGaugeViewModel>();
        const nowMs = nowServerMs();
        for (const agentId of params.agentIds) {
            const ref = profileRefByAgentId.get(agentId) ?? null;
            const source = selectProviderUsageDisplaySnapshot({
                providerId: agentId,
                // A session can retain usage refs from before a provider switch. The display
                // selector checks each snapshot's provider identity rather than the session's current one.
                metadataRecordIds: allRecordIds,
                accountUsageSnapshotsByRecordId: accountUsageSnapshots,
                connectedServiceProfileRef: ref ? { ...ref, provenance: 'published_quota_ref' } : null,
                connectedServiceQuotaView: ref ? quotaSnapshots.snapshotsByKey[connectedServiceProfileKey(ref)] ?? null : null,
            });
            // A native CLI may publish a limit-hit issue before it has an account snapshot.
            // Explicit connected profiles must never borrow a different login's runtime evidence.
            const gaugeSource = selectConnectedServiceSessionProviderUsageGaugeSource({
                providerId: agentId,
                connectedServiceSnapshot: source?.snapshot ?? null,
                connectedServiceRefProvenance: source?.connectedServiceRefProvenance,
                runtimeIssue: ref ? null : latestRuntimeIssuesByAgent.get(agentId),
                nowMs,
            });
            if (!gaugeSource) continue;
            const gauge = computeConnectedServiceQuotaGaugeViewModel({
                snapshot: gaugeSource.snapshot,
                windowMode: params.windowMode,
                windowModes,
                nowMs,
                formatter: connectedServiceQuotaGaugeFormatter,
                providerDisplayName: t(getAgentCore(agentId).displayNameKey),
            });
            if (gauge) gauges.set(agentId, gauge);
        }
        return gauges;
    }, [accountUsageSnapshots, allRecordIds, params.agentIds, params.windowMode, windowModes, profileRefByAgentId, quotaSnapshots.snapshotsByKey, latestRuntimeIssuesByAgent]);
    const configuredAgentIds = React.useMemo(() => new Set(
        params.agentIds.filter((agentId) => (
            // Configuration and query eligibility are different facts. A refresh/reconnect status
            // must not remove a saved provider from the HUD while its figures are unavailable.
            (getAgentCore(agentId).connectedServices?.supportedServiceIds ?? []).some((serviceId) => (
                params.accountProfileConnectedServicesV2.some((service) => service.serviceId === serviceId
                    && service.profiles.some((profile) => profile.profileId.trim().length > 0))
            ))
            || recordIdsByAgentId.has(agentId)
            || latestRuntimeIssuesByAgent.has(agentId)
        )),
    ), [params.agentIds, params.accountProfileConnectedServicesV2, recordIdsByAgentId, latestRuntimeIssuesByAgent]);
    return React.useMemo(() => ({ gauges, configuredAgentIds, refreshAgent }), [gauges, configuredAgentIds, refreshAgent]);
}
