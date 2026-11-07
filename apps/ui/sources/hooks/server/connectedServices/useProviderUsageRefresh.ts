import * as React from 'react';

import { resolveAgentIdFromSessionMetadata } from '@happier-dev/agents';
import {
    ConnectedServiceIdSchema,
    isConnectedServiceCredentialHealthStatusUsable,
    readProviderAccountUsageRecordIdsFromMetadata,
    type AccountProfile,
    type ConnectedServiceQuotaMeterV1,
    type SessionRuntimeIssueV1,
} from '@happier-dev/protocol';

import { resolveConnectedServiceQuotaProfileRefForSession } from '@/components/sessions/shell/resolveConnectedServiceQuotaProfileRefForSession';
import { readProviderAccountUsageSnapshotFromCache } from '@/sync/domains/connectedServices/accountUsage/cache';
import { deriveQuotaMeterValues } from '@/sync/domains/connectedServices/deriveQuotaUtilizationPct';
import type { Session } from '@/sync/domains/state/storageTypes';
import { nowServerMs } from '@/sync/runtime/time';
import { useAuth } from '@/auth/context/AuthContext';
import { resolveAuthCredentialsScopeKey } from '@/auth/storage/resolveAuthCredentialsScopeKey';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { refreshProviderAccountUsage } from '@/sync/domains/connectedServices/accountUsage/refreshProviderAccountUsage';
import { collectConfiguredProviderUsageRefreshTargets, type ProviderUsageRefreshTarget } from '@/sync/domains/connectedServices/accountUsage/providerUsageRefreshTargets';
import { connectedServiceProfileKey } from '@/sync/domains/connectedServices/connectedServiceProfilePreferences';
import { useProfile } from '@/sync/domains/state/storage';
import { useLatestProviderUsageRecordIdsByAgent } from '@/sync/store/hooks';
import {
    buildQuotaSnapshotScopeKey,
    getQuotaSnapshotEntry,
    refreshQuotaSnapshot,
    type CredentialScopedAccountMode,
} from '@/sync/domains/connectedServices/connectedServiceQuotaSnapshotStore';
import { fireAndForget } from '@/utils/system/fireAndForget';

import { useCredentialScopedAccountModeResolver } from './useCredentialScopedAccountModeResolver';

export type { ProviderUsageRefreshTarget } from '@/sync/domains/connectedServices/accountUsage/providerUsageRefreshTargets';

type AutomaticRefreshTarget = ProviderUsageRefreshTarget & Readonly<{ usageLimitIssue?: SessionRuntimeIssueV1 }>;

export type ProviderUsageRefreshContext = Readonly<{
    credentials: AuthCredentials;
    credentialScope: string;
    resolveAccountMode: () => Promise<CredentialScopedAccountMode>;
    configuredTargets?: readonly ProviderUsageRefreshTarget[];
    automaticTargets?: readonly AutomaticRefreshTarget[];
}>;

/** Automatic work follows live Session account bindings, including their current pool member. */
export function collectAutomaticProviderUsageRefreshTargets(params: Readonly<{
    sessions: ReadonlyArray<Pick<Session, 'active' | 'metadata' | 'archivedAt' | 'lastRuntimeIssue' | 'latestTurnStatus'>>;
    connectedServices: AccountProfile['connectedServicesV2'];
}>): readonly AutomaticRefreshTarget[] {
    const targets: AutomaticRefreshTarget[] = [];
    for (const session of params.sessions) {
        if (!session.active || session.archivedAt != null) continue;
        const agentId = resolveAgentIdFromSessionMetadata(session.metadata);
        if (!agentId) continue;
        const profile = resolveConnectedServiceQuotaProfileRefForSession({
            metadata: session.metadata, agentId, accountProfileConnectedServicesV2: params.connectedServices,
        });
        if (profile?.credentialHealthStatus && !isConnectedServiceCredentialHealthStatusUsable(profile.credentialHealthStatus)) continue;
        const issue = session.lastRuntimeIssue;
        const usageLimitIssue = (session.latestTurnStatus == null || session.latestTurnStatus === 'failed')
            && issue?.status === 'failed' && issue.source === 'usage_limit' && issue.usageLimit
            && issue.provider === agentId
            ? issue : null;
        targets.push({
            connectedProfileRef: profile ? { serviceId: profile.serviceId, profileId: profile.profileId } : null,
            recordIds: readProviderAccountUsageRecordIdsFromMetadata(session.metadata),
            ...(usageLimitIssue ? { usageLimitIssue } : {}),
        });
    }
    return targets;
}

function readExhaustedMeterResets(meters: readonly ConnectedServiceQuotaMeterV1[]): (number | null)[] {
    return meters.flatMap((meter) => {
        const remainingPct = deriveQuotaMeterValues(meter).remainingPct;
        return remainingPct != null && remainingPct <= 0 ? [meter.resetAtMs ?? meter.resetsAt ?? null] : [];
    });
}

function hasHealthyUsageObservation(meters: readonly ConnectedServiceQuotaMeterV1[]): boolean {
    return meters.length > 0 && meters.every((meter) => (
        meter.status === 'ok' && (deriveQuotaMeterValues(meter).remainingPct ?? 0) > 0
    ));
}

function selectAutomaticTargets(context: ProviderUsageRefreshContext): readonly ProviderUsageRefreshTarget[] {
    const nowMs = nowServerMs();
    const targets = context.automaticTargets ?? [];
    const blockedProfiles = new Set<string>();
    const blockedRecords = new Set<string>();
    for (const target of targets) {
        const profile = target.connectedProfileRef;
        const serviceId = ConnectedServiceIdSchema.safeParse(profile?.serviceId);
        const quota = profile && serviceId.success
            ? getQuotaSnapshotEntry(buildQuotaSnapshotScopeKey(context.credentialScope, serviceId.data, profile.profileId)).snapshot
            : null;
        const accountUsage = target.recordIds.map((recordId) => readProviderAccountUsageSnapshotFromCache({
            credentialScope: context.credentialScope, recordId,
        }));
        const latestHealthyObservationAtMs = Math.max(
            quota && hasHealthyUsageObservation(quota.meters) ? quota.fetchedAt : 0,
            ...accountUsage.map((snapshot) => snapshot?.state === 'loaded_data' && hasHealthyUsageObservation(snapshot.meters)
                ? snapshot.observedAtMs : 0),
        );
        const exhaustedResets = readExhaustedMeterResets([
            ...(quota?.meters ?? []), ...accountUsage.flatMap((snapshot) => snapshot?.meters ?? []),
        ]);
        const snapshotResetAtMs = exhaustedResets.length > 0 && !exhaustedResets.includes(null)
            ? Math.max(...exhaustedResets.map((reset) => reset ?? 0)) : null;
        const issue = target.usageLimitIssue;
        const applicableSnapshotResetAtMs = snapshotResetAtMs != null && snapshotResetAtMs > (issue?.occurredAt ?? 0)
            ? snapshotResetAtMs : null;
        const resetAtMs = issue?.usageLimit?.resetAtMs ?? (issue?.usageLimit?.retryAfterMs != null
            ? issue.occurredAt + issue.usageLimit.retryAfterMs : applicableSnapshotResetAtMs);
        // A newer healthy observation can clear a failure; until then its reset is authoritative even without cached meters.
        // Cached exhausted windows can supply the reset when the failure itself had no timing.
        const issueExhausted = issue && latestHealthyObservationAtMs <= issue.occurredAt && (resetAtMs == null || resetAtMs > nowMs);
        const exhausted = issueExhausted || exhaustedResets.some((reset) => reset == null || reset > nowMs);
        if (!exhausted) continue;
        if (profile) blockedProfiles.add(connectedServiceProfileKey(profile));
        for (const recordId of target.recordIds) blockedRecords.add(recordId);
    }
    return targets.filter((target) => (
        (!target.connectedProfileRef || !blockedProfiles.has(connectedServiceProfileKey(target.connectedProfileRef)))
        && !target.recordIds.some((recordId) => blockedRecords.has(recordId))
    ));
}

/** The signed-in scope and configured usage sources, or null when quotas are off or nobody is signed in. */
export function useProviderUsageRefreshContext(): ProviderUsageRefreshContext | null {
    const credentials = useAuth().credentials;
    const quotasEnabled = useFeatureEnabled('connectedServices.quotas');
    const credentialScope = quotasEnabled && credentials ? resolveAuthCredentialsScopeKey(credentials) : '';
    const resolveAccountMode = useCredentialScopedAccountModeResolver({ credentials, credentialScope });
    const connectedServices = useProfile()?.connectedServicesV2;
    const latestRecordIdsByAgent = useLatestProviderUsageRecordIdsByAgent();
    const configuredTargets = React.useMemo(() => collectConfiguredProviderUsageRefreshTargets({
        connectedServices: connectedServices ?? [], latestRecordIdsByAgent,
    }), [connectedServices, latestRecordIdsByAgent]);
    return React.useMemo(
        () => (credentials && credentialScope ? { credentials, credentialScope, resolveAccountMode, configuredTargets } : null),
        [credentialScope, credentials, resolveAccountMode, configuredTargets],
    );
}

/**
 * "Query the provider now" includes all configured providers: refreshes connected-service quota profiles and
 * each provider account usage record it reads from. Both routes ask the server to have the
 * owning daemon re-query the provider; the new figures arrive through the usual snapshot caches.
 * Automatic calls select live account targets and apply exhaustion/reset eligibility before either route.
 */
export function runProviderUsageRefresh(context: ProviderUsageRefreshContext, target: ProviderUsageRefreshTarget, options?: Readonly<{ automatic: boolean }>): void {
    const profiles = new Map<string, NonNullable<ProviderUsageRefreshTarget['connectedProfileRef']>>();
    const recordIds = new Set<string>();
    // Automatic eligibility is applied before either request route; never expand it back to configured accounts.
    const targets = options?.automatic ? selectAutomaticTargets(context) : [target, ...(context.configuredTargets ?? [])];
    for (const candidate of targets) {
        if (candidate.connectedProfileRef) profiles.set(connectedServiceProfileKey(candidate.connectedProfileRef), candidate.connectedProfileRef);
        for (const recordId of candidate.recordIds) recordIds.add(recordId);
    }
    for (const connectedProfileRef of profiles.values()) {
        const serviceId = ConnectedServiceIdSchema.safeParse(connectedProfileRef.serviceId);
        if (serviceId.success) {
            fireAndForget(
                refreshQuotaSnapshot(
                    buildQuotaSnapshotScopeKey(context.credentialScope, serviceId.data, connectedProfileRef.profileId),
                    {
                        credentials: context.credentials,
                        credentialScope: context.credentialScope,
                        serviceId: serviceId.data,
                        profileId: connectedProfileRef.profileId,
                        resolveAccountMode: context.resolveAccountMode,
                    },
                ),
                { tag: 'runProviderUsageRefresh.connectedService' },
            );
        }
    }
    for (const recordId of recordIds) {
        fireAndForget((async () => {
            await refreshProviderAccountUsage({
                credentials: context.credentials,
                credentialScope: context.credentialScope,
                recordId,
                mode: await context.resolveAccountMode(),
            });
        })(), { tag: 'runProviderUsageRefresh.accountUsage' });
    }
}

/** A stable refresh-all press handler, retaining the surface's explicit account as an additional target. */
export function useProviderUsageRefresh(target: ProviderUsageRefreshTarget): () => void {
    const context = useProviderUsageRefreshContext();
    const { connectedProfileRef, recordIds } = target;
    return React.useCallback(() => {
        if (context) runProviderUsageRefresh(context, { connectedProfileRef, recordIds });
    }, [connectedProfileRef, context, recordIds]);
}
