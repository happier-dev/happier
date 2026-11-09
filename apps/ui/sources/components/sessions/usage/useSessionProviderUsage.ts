import * as React from 'react';
import type { ConnectedServiceQuotaSnapshotV1 } from '@happier-dev/protocol/connect/connected-service-schemas';
import { parseQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { readProviderAccountUsageRecordIdsFromMetadata } from '@happier-dev/protocol/sessions/metadata/providerAccountUsageRefsV1';

import { useSessionAgentCatalogIdentity } from '@/agents/registry/useSessionAgentCatalogIdentity';
import { buildLiveSessionAuthoringContext } from '@/components/sessions/authoring/context/buildLiveSessionAuthoringContext';
import { resolveSessionComposerStateFromAuthoringContext } from '@/components/sessions/authoring/context/resolveSessionComposerStateFromAuthoringContext';
import { useSessionReachableMachineTarget } from '@/components/sessions/model/useSessionMachineReachability';
import { resolveConnectedServiceQuotaProfileRefForSession } from '@/components/sessions/shell/resolveConnectedServiceQuotaProfileRefForSession';
import { readSessionUsageLimitRecoveryFromMetadata } from '@/components/sessions/usageLimitRecovery/sessionUsageLimitRecoveryPresentation';
import { useConnectedServiceQuotaSnapshots } from '@/hooks/server/connectedServices/useConnectedServiceQuotaSnapshots';
import { useProviderAccountUsageSnapshots } from '@/hooks/server/connectedServices/useProviderAccountUsageSnapshots';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import {
  computeProviderAccountUsageGaugeViewModel,
  selectProviderUsageDisplaySource,
} from '@/sync/domains/connectedServices/accountUsage/providerAccountUsageSelectors';
import { resolveQualifiedConnectedAccountProfilePreference } from '@/sync/domains/connectedServices/connectedServiceProfilePreferences';
import {
  computeConnectedServiceQuotaGaugeViewModel,
  selectConnectedServiceSessionProviderUsageSnapshot,
  type ConnectedServiceQuotaGaugeLabelFormatter,
  type ConnectedServiceQuotaGaugeViewModel,
  type ConnectedServiceQuotaGaugeWindowMode,
} from '@/sync/domains/connectedServices/connectedServiceQuotaGauge';
import { resolveConnectedAccountUiNegotiation } from '@/sync/domains/connectedServices/resolveConnectedAccountUiNegotiation';
import { useServerFeaturesSnapshotForServerId } from '@/sync/domains/features/featureDecisionRuntime';
import { readSessionPresentationAgentId } from '@/sync/domains/session/presentation/readSessionPresentationAgentId';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { useProfile, useSetting } from '@/sync/domains/state/storage';
import type { Session } from '@/sync/domains/state/storageTypes';
import { t } from '@/text';

const connectedServiceQuotaGaugeFormatter: ConnectedServiceQuotaGaugeLabelFormatter =
  {
    remaining: ({ percent }) =>
      t('agentInput.providerUsage.remaining', { percent }),
    remainingWithReset: ({ percent, reset }) =>
      t('agentInput.providerUsage.remainingWithReset', { percent, reset }),
    used: ({ used, limit }) =>
      t('agentInput.providerUsage.usedCount', { used, limit }),
    durationNow: () => t('agentInput.providerUsage.duration.now'),
    durationOutdated: () => t('agentInput.providerUsage.duration.outdated'),
    durationDaysHours: ({ days, hours }) =>
      t('agentInput.providerUsage.duration.daysHours', { days, hours }),
    durationHoursMinutes: ({ hours, minutes }) =>
      t('agentInput.providerUsage.duration.hoursMinutes', { hours, minutes }),
    durationHours: ({ hours }) =>
      t('agentInput.providerUsage.duration.hours', { hours }),
    durationMinutes: ({ minutes }) =>
      t('agentInput.providerUsage.duration.minutes', { minutes }),
  };

function connectedServiceQuotaSnapshotMatchesProfileRef(
  snapshot: ConnectedServiceQuotaSnapshotV1 | null | undefined,
  profileRef:
    | Readonly<{ serviceId: string; profileId: string }>
    | null
    | undefined,
): boolean {
  return Boolean(
    snapshot &&
    profileRef &&
    snapshot.serviceId === profileRef.serviceId &&
    snapshot.profileId === profileRef.profileId,
  );
}

function readGaugeWindowMode(
  value: unknown,
): ConnectedServiceQuotaGaugeWindowMode {
  return value === 'daily' ||
    value === 'weekly' ||
    value === 'primary' ||
    value === 'secondary' ||
    value === 'session'
    ? value
    : 'most_constrained';
}

export type SessionProviderUsageInput = Readonly<{
  session: Session;
  /** The Session's Home. */
  serverId: string;
  /** The Session's Agent, as its composer state resolves it. */
  agentId: string | null;
  /** The Session's active model: its model selection, else its composer model mode. */
  activeModelId: string | null | undefined;
}>;

/**
 * The one owner of a Session's provider usage: the quota/account-usage source it
 * presents, the recovery credits it carries, and the gauge the composer's
 * instrument strip and the Session Companion show. Consumers read its result;
 * none recomputes the gauge.
 */
export function useSessionProviderUsage(input: SessionProviderUsageInput) {
  const { session, serverId, agentId, activeModelId } = input;
  const ownerMetadata = readSessionOwnerMetadataView(session);
  const machineId =
    useSessionReachableMachineTarget(session.id, serverId)?.machineId ??
    ownerMetadata?.machineId ??
    null;
  const catalogIdentity = useSessionAgentCatalogIdentity({
    agentId: agentId ?? '',
    machineId: typeof machineId === 'string' ? machineId : null,
    serverId,
  });
  const connectedAccounts = catalogIdentity.entry.connectedAccounts;
  const quotasEnabled = useFeatureEnabled('connectedServices.quotas');
  // Only the connected-service facts usage reads; a timestamp-only Account update leaves it still.
  const accountProfile = useProfile((profile) => ({
    connectedServicesV2: profile?.connectedServicesV2,
    connectedAccountGroupsV4: profile?.connectedAccountGroupsV4,
  }), ['connectedServicesV2', 'connectedAccountGroupsV4']);
  const connectedAccountTransport = resolveConnectedAccountUiNegotiation(
    useServerFeaturesSnapshotForServerId(serverId),
  );
  const gaugeMode = useSetting('sessionProviderUsageGaugeMode');
  const windowMode = readGaugeWindowMode(
    useSetting('sessionProviderUsageGaugeWindowMode'),
  );
  const windowModes = useSetting('sessionProviderUsageGaugeWindowModes');
  const pinnedMeterIdsByKey = useSetting(
    'connectedServicesQuotaPinnedMeterIdsByKey',
  );
  const quotaProfileRef = React.useMemo(
    () =>
      resolveConnectedServiceQuotaProfileRefForSession({
        metadata: ownerMetadata,
        agentId: agentId ?? '',
        accountProfileConnectedServicesV2:
          accountProfile?.connectedServicesV2 ?? [],
        accountProfileConnectedAccountGroupsV4:
          connectedAccountTransport === 'legacy'
            ? undefined
            : (accountProfile?.connectedAccountGroupsV4 ?? []),
        connectedAccounts,
      }),
    [
      accountProfile?.connectedServicesV2,
      accountProfile?.connectedAccountGroupsV4,
      connectedAccountTransport,
      agentId,
      connectedAccounts,
      ownerMetadata,
    ],
  );
  const quotaSnapshots = useConnectedServiceQuotaSnapshots(
    quotaProfileRef
      ? [
          {
            serviceId: quotaProfileRef.legacyServiceId,
            profileId: quotaProfileRef.profileId,
          },
        ]
      : [],
  );
  /**
   * The released scalar identity the session quota corridor consumes (V2/V3
   * quota transports, the recovery-credit consume wire, V2 group facts). The
   * resolver's canonical resolution is qualified; this is its typed local
   * projection for the legacy quota surfaces.
   */
  const quotaProfileIdentity = React.useMemo(
    () =>
      quotaProfileRef
        ? {
            serviceId: quotaProfileRef.legacyServiceId,
            profileId: quotaProfileRef.profileId,
          }
        : null,
    [quotaProfileRef],
  );
  const quotaProfileKey = quotaSnapshots.profiles[0]?.key ?? null;
  const polledQuotaSnapshot = quotaProfileKey
    ? (quotaSnapshots.snapshotsByKey[quotaProfileKey] ?? null)
    : null;
  // A consumed recovery credit returns a fresher snapshot than the poll until the poll catches up.
  const [quotaSnapshotOverride, setQuotaSnapshotOverride] =
    React.useState<Readonly<{
      profileKey: string;
      snapshot: ConnectedServiceQuotaSnapshotV1;
    }> | null>(null);
  const quotaSnapshot =
    quotaSnapshotOverride &&
    quotaSnapshotOverride.profileKey === quotaProfileKey &&
    (!polledQuotaSnapshot ||
      quotaSnapshotOverride.snapshot.fetchedAt >= polledQuotaSnapshot.fetchedAt)
      ? quotaSnapshotOverride.snapshot
      : polledQuotaSnapshot;
  React.useEffect(() => {
    if (!quotaSnapshotOverride) return;
    if (quotaSnapshotOverride.profileKey !== quotaProfileKey) {
      setQuotaSnapshotOverride(null);
      return;
    }
    if (
      polledQuotaSnapshot &&
      polledQuotaSnapshot.fetchedAt >= quotaSnapshotOverride.snapshot.fetchedAt
    ) {
      setQuotaSnapshotOverride(null);
    }
  }, [polledQuotaSnapshot, quotaProfileKey, quotaSnapshotOverride]);
  /** Applies a consumed recovery credit's receipt: its snapshot, or none (drop a retained one for that profile). */
  const applyRecoveryCreditSnapshot = React.useCallback(
    (profileKey: string, snapshot: ConnectedServiceQuotaSnapshotV1 | null) => {
      if (snapshot) {
        setQuotaSnapshotOverride({ profileKey, snapshot });
        return;
      }
      setQuotaSnapshotOverride((current) =>
        current?.profileKey === profileKey ? null : current,
      );
    },
    [],
  );
  const quotaLimitSelection = React.useMemo(() => {
    if (!quotaProfileRef?.groupId) return undefined;
    const service = parseQualifiedPluginContributionKey(
      quotaProfileRef.serviceKey,
    );
    if (!service) return null;
    const group = accountProfile?.connectedAccountGroupsV4?.find(
      (candidate) =>
        candidate.ref.groupId === quotaProfileRef.groupId &&
        candidate.ref.service.pluginId === service.pluginId &&
        candidate.ref.service.localId === service.localId,
    );
    return group ? group.policy.quotaLimitSelection : null;
  }, [
    accountProfile?.connectedAccountGroupsV4,
    quotaProfileRef?.groupId,
    quotaProfileRef?.serviceKey,
  ]);
  const accountUsageRecordIds = React.useMemo(
    () => readProviderAccountUsageRecordIdsFromMetadata(ownerMetadata),
    [ownerMetadata],
  );
  const accountUsageSnapshots = useProviderAccountUsageSnapshots(
    accountUsageRecordIds,
  );
  const displaySource = React.useMemo(
    () =>
      selectProviderUsageDisplaySource({
        providerId: agentId,
        metadataRecordIds: accountUsageRecordIds,
        accountUsageSnapshotsByRecordId:
          accountUsageSnapshots.snapshotsByRecordId,
        connectedServiceProfileRef: quotaProfileIdentity,
        connectedServiceQuotaView: quotaSnapshot,
      }),
    [
      agentId,
      quotaProfileIdentity,
      quotaSnapshot,
      accountUsageRecordIds,
      accountUsageSnapshots.snapshotsByRecordId,
    ],
  );
  const accountUsageSnapshot =
    displaySource?.kind === 'account_usage' ? displaySource.snapshot : null;
  const accountUsageStateByRecordId = accountUsageSnapshots.stateByRecordId;
  const usageLimitRecoveryState = React.useMemo(
    () => readSessionUsageLimitRecoveryFromMetadata(ownerMetadata),
    [ownerMetadata],
  );
  const recoveryCredits = quotaProfileRef
    ? (quotaSnapshot?.recoveryCredits ?? null)
    : (accountUsageSnapshot?.recoveryCredits ??
      usageLimitRecoveryState?.recoveryCredits ??
      null);
  const runtimeIssue = session.lastRuntimeIssue ?? null;
  const gaugeQuotaSnapshot = quotaProfileRef
    ? displaySource?.kind === 'connected_service_quota_view'
      ? selectConnectedServiceSessionProviderUsageSnapshot({
          connectedServiceSnapshot: displaySource.snapshot,
          recoveryCredits,
          runtimeIssue,
        })
      : null
    : selectConnectedServiceSessionProviderUsageSnapshot({
        connectedServiceSnapshot: quotaSnapshot,
        recoveryCredits,
        runtimeIssue,
      });
  const gaugeQuotaProfileIdentity =
    displaySource?.kind === 'connected_service_quota_view' &&
    gaugeQuotaSnapshot &&
    connectedServiceQuotaSnapshotMatchesProfileRef(
      gaugeQuotaSnapshot,
      quotaProfileIdentity,
    )
      ? quotaProfileIdentity
      : null;
  const gauge =
    React.useMemo((): ConnectedServiceQuotaGaugeViewModel | null => {
      if (!quotasEnabled || gaugeMode === 'hidden') return null;
      if (quotaProfileRef) {
        if (displaySource?.kind !== 'connected_service_quota_view') {
          return null;
        }
        const sourceAccount = gaugeQuotaSnapshot;
        const pinnedService =
          sourceAccount?.serviceId === quotaProfileRef.legacyServiceId
            ? parseQualifiedPluginContributionKey(quotaProfileRef.serviceKey)
            : null;
        const additionalMeterIds =
          pinnedService && sourceAccount
            ? resolveQualifiedConnectedAccountProfilePreference({
                valuesByKey: pinnedMeterIdsByKey,
                service: pinnedService,
                legacyServiceId: quotaProfileRef.legacyServiceId,
                accountId: sourceAccount.profileId,
              })
            : undefined;
        return computeConnectedServiceQuotaGaugeViewModel({
          snapshot: gaugeQuotaSnapshot,
          activeModelId,
          additionalMeterIds,
          quotaLimitSelection,
          windowMode,
          windowModes,
          nowMs: Date.now(),
          formatter: connectedServiceQuotaGaugeFormatter,
        });
      }
      const connectedServiceGauge = computeConnectedServiceQuotaGaugeViewModel({
        snapshot: gaugeQuotaSnapshot,
        activeModelId,
        quotaLimitSelection,
        windowMode,
        windowModes,
        nowMs: Date.now(),
        formatter: connectedServiceQuotaGaugeFormatter,
      });
      if (connectedServiceGauge) return connectedServiceGauge;
      return computeProviderAccountUsageGaugeViewModel({
        snapshot: accountUsageSnapshot,
        activeModelId,
        // The snapshots hook already resolved this record's state, including the
        // failed-refresh case its retained snapshot cannot express on its own.
        state: accountUsageSnapshot
          ? (accountUsageStateByRecordId[accountUsageSnapshot.recordId] ??
            'not_loaded')
          : 'not_loaded',
        windowMode,
        windowModes,
        nowMs: Date.now(),
        formatter: connectedServiceQuotaGaugeFormatter,
      });
    }, [
      activeModelId,
      quotaProfileRef,
      quotasEnabled,
      quotaLimitSelection,
      pinnedMeterIdsByKey,
      windowModes,
      displaySource?.kind,
      gaugeQuotaSnapshot,
      accountUsageSnapshot,
      accountUsageStateByRecordId,
      gaugeMode,
      windowMode,
    ]);
  return {
    gauge,
    /** The released scalar profile identity, its snapshot-store key, and its override-aware snapshot. */
    quotaProfileIdentity,
    quotaProfileKey,
    quotaSnapshot,
    /** The gauge's connected-service snapshot and the profile identity it matches, when it does. */
    gaugeQuotaSnapshot,
    gaugeQuotaProfileIdentity,
    accountUsageSnapshot,
    recoveryCredits,
    applyRecoveryCreditSnapshot,
  };
}

export type SessionProviderUsage = ReturnType<typeof useSessionProviderUsage>;

/**
 * The Session's provider usage gauge for surfaces outside its composer (the
 * Session Companion). It resolves the composer's Agent and model through the
 * same Session owners and reads the Agent's catalog entry from the shared inert
 * catalog summary (no daemon work), then delegates to the usage owner.
 */
export function useSessionProviderUsageGauge(
  input: Readonly<{
    session: Session;
    serverId: string;
  }>,
): ConnectedServiceQuotaGaugeViewModel | null {
  const { session, serverId } = input;
  const ownerMetadata = readSessionOwnerMetadataView(session);
  const composerSubject = React.useMemo(() => {
    const fallbackAgentId = readSessionPresentationAgentId(session);
    const state = resolveSessionComposerStateFromAuthoringContext(
      buildLiveSessionAuthoringContext({ session }),
      {
        fallbackAgentId,
      },
    );
    return {
      agentId: state.agentId ?? fallbackAgentId,
      modelMode: state.modelMode,
    };
  }, [session]);
  const composerOptionsInput =
    session.composerOptionsInput === undefined
      ? ownerMetadata
      : session.composerOptionsInput;
  const activeModelId =
    composerOptionsInput?.modelSelectionIntentV1?.selection?.modelId ??
    composerSubject.modelMode;
  return useSessionProviderUsage({
    session,
    serverId,
    agentId: composerSubject.agentId,
    activeModelId,
  }).gauge;
}
