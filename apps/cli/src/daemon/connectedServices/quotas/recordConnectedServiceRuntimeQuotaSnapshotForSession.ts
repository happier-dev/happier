import type {
  ConnectedServiceId,
  ConnectedServiceQuotaSnapshotV1,
  ConnectedServiceUsageSourceV1,
  ProviderAccountUsageSnapshotV1,
} from '@happier-dev/protocol';

import type { TrackedSession } from '@/daemon/types';

import type { ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore } from '../accountGroups/quotas/ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore';
import { buildProviderAccountUsageSnapshotFromConnectedServiceQuotaObservation } from '../accountUsage/fromConnectedServiceQuotaObservation';
import {
  canRecordProviderAccountUsageSourceLinks,
  recordProviderAccountUsageSnapshotForSession,
  type ProviderAccountUsageRecordIdPublisher,
} from '../accountUsage/record';
import type { ProviderAccountUsagePersistenceScheduler } from '../accountUsage/persistence';
import {
  isProviderAccountUsageStoreMutationAccepted,
  type ProviderAccountUsageObservation,
  type ProviderAccountUsageStore,
} from '../accountUsage/store';
import { readConnectedServiceChildSelectionsFromEnv } from '../connectedServiceChildEnvironment';
import {
  parseConnectedServiceBindingSelections,
  type ConnectedServiceBindingSelection,
} from '../parseConnectedServicesBindings';
import { resolveTrackedConnectedServiceBindingsRaw } from '../trackedSessionConnectedServiceBindings';
import { normalizeConnectedServiceAccessTokenFingerprint } from '../refresh/credentialFreshness/tokenFingerprint';
import type {
  QuotaProbeAppliedIdentity,
  QuotaProbeFreshProofResult,
} from './proof/quotaProbeFreshProof';

type AccountUsageRecorderLike = Readonly<{
  store: Pick<ProviderAccountUsageStore, 'recordSnapshot' | 'resolveRecordId' | 'resolveBySource'>;
  persistence: Pick<ProviderAccountUsagePersistenceScheduler, 'recordInBandSnapshot'> | null;
  publishRecordId?: ProviderAccountUsageRecordIdPublisher;
}>;

type AccountUsageChangedNotifier = (input: Readonly<{
  sessionId: string;
  serviceId: ConnectedServiceId;
  profileId: string;
  groupId: string;
  groupGeneration: number;
  recordId: string;
  snapshot: ProviderAccountUsageSnapshotV1;
  source: 'in_band' | 'evidence_only';
}>) => Promise<void> | void;

type QuotaProbeFreshProofResolver = (input: Readonly<{
  serviceId: ConnectedServiceId;
  profileId: string;
  expectedAppliedIdentity: QuotaProbeAppliedIdentity | null;
  snapshotAppliedIdentity: QuotaProbeAppliedIdentity | null;
  snapshot: ConnectedServiceQuotaSnapshotV1;
}>) => QuotaProbeFreshProofResult;

type QuotaProbeFreshProofRecorder = (input: Readonly<{
  sessionId: string;
  serviceId: ConnectedServiceId;
  profileId: string;
  groupId: string | null;
  proofKind: 'quota_probe_fresh';
  observedAtMs: number;
}>) => Promise<void> | void;

function normalizeSessionId(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeNullableString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function normalizeNonNegativeInt(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return null;
  return value;
}

function findTrackedSession(
  children: ReadonlyArray<TrackedSession>,
  sessionId: string,
): TrackedSession | null {
  const normalized = normalizeSessionId(sessionId);
  if (!normalized) return null;
  return children.find((child) => normalizeSessionId(child.happySessionId) === normalized) ?? null;
}

function buildAccountUsageSnapshotForRuntimeQuota(input: Readonly<{
  snapshot: ConnectedServiceQuotaSnapshotV1;
  groupGeneration?: number | null;
  sourceProviderAccountId?: string | null;
}>): ProviderAccountUsageSnapshotV1 {
  return buildProviderAccountUsageSnapshotFromConnectedServiceQuotaObservation({
    snapshot: input.snapshot,
    sourceProviderAccountId: input.sourceProviderAccountId,
  });
}

function buildRuntimeQuotaObservation(input: Readonly<{
  serviceId: ConnectedServiceId;
  profileId: string;
  selection: ConnectedServiceBindingSelection | null;
  groupGeneration?: number | null;
}>): ProviderAccountUsageObservation {
  let source: ConnectedServiceUsageSourceV1 | undefined;
  if (input.selection?.kind === 'group') {
    source = {
      serviceId: input.serviceId,
      profileId: input.profileId,
      bindingKind: 'group_member',
      groupId: input.selection.groupId,
      ...(input.groupGeneration !== null && input.groupGeneration !== undefined
        ? { groupGeneration: input.groupGeneration }
        : {}),
    };
  } else if (input.selection?.kind === 'profile') {
    source = {
      serviceId: input.serviceId,
      profileId: input.profileId,
      bindingKind: 'profile',
    };
  }
  return {
    ...(source ? { sources: [source] } : {}),
  };
}

export async function recordConnectedServiceRuntimeQuotaSnapshotForSession(input: Readonly<{
  accountUsageRecorder?: AccountUsageRecorderLike | null;
  getChildren: () => ReadonlyArray<TrackedSession>;
  notifyAccountUsageChanged?: AccountUsageChangedNotifier;
  runtimeQuotaSnapshots: ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore;
  sessionId: string;
  serviceId: ConnectedServiceId;
  groupId?: string | null;
  groupGeneration?: number | null;
  sourceProviderAccountId?: string | null;
  credentialFingerprint?: string | null;
  policyDisposition?: 'evidence_only';
  resolveProviderQualifiedGroupSource?: (input: Readonly<{
    serviceId: ConnectedServiceId;
    groupId: string;
    providerAccountId: string;
  }>) => Promise<Readonly<{ profileId: string; groupGeneration: number }> | null>;
  verifyCredentialFingerprint?: (input: Readonly<{
    serviceId: ConnectedServiceId;
    profileId: string;
    providerAccountId: string;
    credentialFingerprint: string;
  }>) => Promise<boolean>;
  resolveCurrentGroupGenerationForProfile?: (input: Readonly<{
    serviceId: ConnectedServiceId;
    groupId: string;
    profileId: string;
  }>) => Promise<number | null>;
  resolveExpectedQuotaProbeAppliedIdentity?: (input: Readonly<{
    serviceId: ConnectedServiceId;
    profileId: string;
    groupId: string | null;
    groupGeneration: number | null;
  }>) => Promise<QuotaProbeAppliedIdentity | null>;
  resolveQuotaProbeFreshProof?: QuotaProbeFreshProofResolver;
  recordQuotaProbeFreshProof?: QuotaProbeFreshProofRecorder;
  snapshot: ConnectedServiceQuotaSnapshotV1;
}>): Promise<
  | Readonly<{ status: 'recorded'; groupRuntimeStateRecorded: boolean; quotaStateRecorded: boolean }>
  | Readonly<{ status: 'session_not_found' }>
  | Readonly<{ status: 'service_id_mismatch' }>
  | Readonly<{
      status: 'credential_fingerprint_mismatch';
      recordId: string;
      persisted: false;
    }>
> {
  if (input.snapshot.serviceId !== input.serviceId) return { status: 'service_id_mismatch' };

  const tracked = findTrackedSession(input.getChildren(), input.sessionId);
  if (!tracked) return { status: 'session_not_found' };
  const bindingsRaw = resolveTrackedConnectedServiceBindingsRaw(tracked);
  const selection = parseConnectedServiceBindingSelections(bindingsRaw)
    .find((candidate) => candidate.serviceId === input.serviceId) ?? null;
  const sourceProviderAccountId = normalizeNullableString(input.sourceProviderAccountId);
  const reportedGroupId = normalizeNullableString(input.groupId);
  const providerQualifiedGroupSource =
    selection?.kind === 'group'
    && reportedGroupId === selection.groupId
    && sourceProviderAccountId
    && input.resolveProviderQualifiedGroupSource
      ? await input.resolveProviderQualifiedGroupSource({
          serviceId: input.serviceId,
          groupId: selection.groupId,
          providerAccountId: sourceProviderAccountId,
        }).catch(() => null)
      : null;
  const effectiveSnapshot = providerQualifiedGroupSource
    && providerQualifiedGroupSource.profileId !== input.snapshot.profileId
      ? { ...input.snapshot, profileId: providerQualifiedGroupSource.profileId }
      : input.snapshot;
  const accountUsageSnapshot = buildAccountUsageSnapshotForRuntimeQuota({
    snapshot: effectiveSnapshot,
    sourceProviderAccountId: input.sourceProviderAccountId,
  });
  const sourceAccountMatchesSnapshot =
    accountUsageSnapshot.accountSubject.kind === 'providerSubject'
    && sourceProviderAccountId === accountUsageSnapshot.accountSubject.id;
  const credentialFingerprint = normalizeConnectedServiceAccessTokenFingerprint(input.credentialFingerprint);
  const verifyCredentialFingerprint = input.verifyCredentialFingerprint;
  const credentialVerificationCandidate =
    selection && sourceProviderAccountId && credentialFingerprint && verifyCredentialFingerprint
      ? {
          serviceId: input.serviceId,
          profileId: effectiveSnapshot.profileId,
          providerAccountId: sourceProviderAccountId,
          credentialFingerprint,
        }
      : null;
  const credentialFingerprintMatchesCurrentSource =
    credentialVerificationCandidate && verifyCredentialFingerprint
      ? await verifyCredentialFingerprint(credentialVerificationCandidate)
      : null;
  const credentialFingerprintVerified =
    sourceAccountMatchesSnapshot && credentialFingerprintMatchesCurrentSource === true;
  const activeGroupSelection = readConnectedServiceChildSelectionsFromEnv(tracked.spawnOptions?.environmentVariables ?? {})
    .find((candidate) => (
      candidate.kind === 'group'
      && candidate.serviceId === input.serviceId
    && candidate.groupId === (selection?.kind === 'group' ? selection.groupId : '')
    )) ?? null;

  const activeGroupSelectionMatchesSnapshotProfile =
    activeGroupSelection?.kind === 'group'
    && activeGroupSelection.activeProfileId === effectiveSnapshot.profileId;
  const reportedGroupGeneration = normalizeNonNegativeInt(input.groupGeneration);
  const activeGroupGeneration = activeGroupSelectionMatchesSnapshotProfile
    && selection?.kind === 'group'
    && reportedGroupId === selection.groupId
    && reportedGroupGeneration === activeGroupSelection.generation
    ? reportedGroupGeneration
    : null;

  const exactCurrentCredentialAccountBinding =
    selection?.kind === 'group'
    && credentialFingerprintVerified
    && canRecordProviderAccountUsageSourceLinks({
      snapshot: accountUsageSnapshot,
      sourceProviderAccountId: input.sourceProviderAccountId,
    });
  const resolvedCurrentGroupGeneration = exactCurrentCredentialAccountBinding
    && input.resolveCurrentGroupGenerationForProfile
    ? await input.resolveCurrentGroupGenerationForProfile({
        serviceId: input.serviceId,
        groupId: selection.groupId,
        profileId: effectiveSnapshot.profileId,
      }).then(normalizeNonNegativeInt).catch(() => null)
    : null;
  const exactCurrentReportedGroupGeneration =
    selection?.kind === 'group'
    && exactCurrentCredentialAccountBinding
    && reportedGroupId === selection.groupId
    && reportedGroupGeneration !== null
    && reportedGroupGeneration === resolvedCurrentGroupGeneration
    ? reportedGroupGeneration
    : null;
  // A surviving runner's launch environment is immutable. After exact hot apply, current
  // credential + provider-account + reported/current generation are the live authority.
  const providerQualifiedGroupGeneration = exactCurrentCredentialAccountBinding
    ? normalizeNonNegativeInt(providerQualifiedGroupSource?.groupGeneration)
    : null;
  const runtimeGroupGeneration = activeGroupGeneration
    ?? exactCurrentReportedGroupGeneration
    ?? providerQualifiedGroupGeneration;
  const effectiveGroupRuntimeStateRecorded =
    selection?.kind === 'group' && runtimeGroupGeneration !== null;
  // Provider-account usage is a different fact: once the current credential and provider account
  // are proven, bind it to authoritative current group truth even when a sibling advanced the
  // generation without changing the logical account.
  const accountUsageGroupGeneration = exactCurrentCredentialAccountBinding
    ? resolvedCurrentGroupGeneration ?? providerQualifiedGroupGeneration ?? activeGroupGeneration
    : activeGroupGeneration;

  const proofGroupId = selection?.kind === 'group' && runtimeGroupGeneration !== null
    ? selection.groupId
    : null;
  const proofGroupGeneration = proofGroupId ? runtimeGroupGeneration : null;
  const selectionMatchesSnapshot = selection?.kind === 'group'
    ? proofGroupId !== null
    : selection?.kind === 'profile' && selection.profileId === effectiveSnapshot.profileId;

  let quotaStateRecorded = false;
  let recordedAccountUsageSnapshot: ProviderAccountUsageSnapshotV1 | null = null;
  let recordedAccountUsageRecordId: string | null = null;
  let recordedAccountUsageSourceLinked = false;
  let recordedAccountUsageEffectiveMutation = false;
  const accountUsageObservation = buildRuntimeQuotaObservation({
    serviceId: input.serviceId,
    profileId: effectiveSnapshot.profileId,
    selection: credentialVerificationCandidate ? selection : null,
    groupGeneration: accountUsageGroupGeneration,
  });
  if (input.accountUsageRecorder) {
    const recorded = await recordProviderAccountUsageSnapshotForSession({
      getChildren: input.getChildren,
      store: input.accountUsageRecorder.store,
      persistence: input.accountUsageRecorder.persistence,
      publishRecordId: input.accountUsageRecorder.publishRecordId,
      sourceProviderAccountId,
      credentialFingerprint,
      verifyCredentialFingerprint: credentialVerificationCandidate
        ? async (candidate) => (
            candidate.serviceId === credentialVerificationCandidate.serviceId
            && candidate.profileId === credentialVerificationCandidate.profileId
            && candidate.providerAccountId === credentialVerificationCandidate.providerAccountId
            && candidate.credentialFingerprint === credentialVerificationCandidate.credentialFingerprint
            && credentialFingerprintMatchesCurrentSource === true
          )
        : undefined,
      observation: accountUsageObservation,
      sessionId: input.sessionId,
      snapshot: accountUsageSnapshot,
    });
    if (recorded.status === 'credential_fingerprint_mismatch') {
      return recorded;
    }
    if (recorded.status !== 'session_not_found') {
      quotaStateRecorded = true;
      recordedAccountUsageRecordId = recorded.recordId;
      recordedAccountUsageSnapshot =
        input.accountUsageRecorder.store.resolveRecordId(recorded.recordId) ?? accountUsageSnapshot;
      recordedAccountUsageSourceLinked = accountUsageObservation.sources?.some((source) =>
        input.accountUsageRecorder?.store.resolveBySource?.(source)?.recordId === recorded.recordId,
      ) === true;
      recordedAccountUsageEffectiveMutation = isProviderAccountUsageStoreMutationAccepted(recorded);
    }
  }

  if (effectiveGroupRuntimeStateRecorded && selection?.kind === 'group') {
    input.runtimeQuotaSnapshots.recordSnapshot({
      serviceId: input.serviceId,
      groupId: selection.groupId,
      profileId: effectiveSnapshot.profileId,
      groupGeneration: runtimeGroupGeneration,
      snapshot: effectiveSnapshot,
    });
  }

  // Canonical runtime/account-usage intake is complete above. Policy fan-out and recovery proof are
  // downstream consumers: run them after intake without extending the runner's delivery deadline.
  void Promise.resolve().then(async () => {
    if (
      recordedAccountUsageSnapshot
      && recordedAccountUsageRecordId
      && recordedAccountUsageSourceLinked
      && recordedAccountUsageEffectiveMutation
      && selection?.kind === 'group'
      && accountUsageGroupGeneration !== null
    ) {
      try {
        await input.notifyAccountUsageChanged?.({
          sessionId: input.sessionId,
          serviceId: input.serviceId,
          groupId: selection.groupId,
          profileId: effectiveSnapshot.profileId,
          groupGeneration: accountUsageGroupGeneration,
          recordId: recordedAccountUsageRecordId,
          snapshot: recordedAccountUsageSnapshot,
          source: input.policyDisposition === 'evidence_only' ? 'evidence_only' : 'in_band',
        });
      } catch {
        // Connected-service policy notification is best effort; account usage remains canonical.
      }
    }

    if (
      selectionMatchesSnapshot
      && credentialFingerprintVerified
      && exactCurrentCredentialAccountBinding
      && input.resolveExpectedQuotaProbeAppliedIdentity
      && input.resolveQuotaProbeFreshProof
      && input.recordQuotaProbeFreshProof
    ) {
      const expectedAppliedIdentity = await input.resolveExpectedQuotaProbeAppliedIdentity({
        serviceId: input.serviceId,
        profileId: effectiveSnapshot.profileId,
        groupId: proofGroupId,
        groupGeneration: proofGroupGeneration,
      }).catch(() => null);
      const snapshotAppliedIdentity: QuotaProbeAppliedIdentity = {
        serviceId: input.serviceId,
        profileId: effectiveSnapshot.profileId,
        groupId: proofGroupId,
        groupGeneration: proofGroupGeneration,
        providerAccountId: normalizeNullableString(input.sourceProviderAccountId),
        materialFingerprint: normalizeConnectedServiceAccessTokenFingerprint(input.credentialFingerprint),
      };
      const proof = input.resolveQuotaProbeFreshProof({
        serviceId: input.serviceId,
        profileId: effectiveSnapshot.profileId,
        expectedAppliedIdentity,
        snapshotAppliedIdentity,
        snapshot: effectiveSnapshot,
      });
      if (proof.status === 'proof') {
        try {
          await input.recordQuotaProbeFreshProof({
            sessionId: input.sessionId,
            serviceId: input.serviceId,
            profileId: effectiveSnapshot.profileId,
            groupId: proofGroupId,
            proofKind: proof.proofKind,
            observedAtMs: effectiveSnapshot.fetchedAt,
          });
        } catch {
          // Recovery proof is optional settlement. Canonical quota/account usage remains valid.
        }
      }
    }
  }).catch(() => {
    // Every optional consumer is contained above; retain a final guard against future additions.
  });

  return {
    status: 'recorded',
    groupRuntimeStateRecorded: effectiveGroupRuntimeStateRecorded,
    quotaStateRecorded,
  };
}
