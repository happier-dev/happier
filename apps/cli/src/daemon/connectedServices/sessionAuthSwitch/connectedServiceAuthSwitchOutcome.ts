import {
  ConnectedServiceCredentialRevisionV1Schema,
  type ConnectedServiceCredentialRevisionV1,
  type ConnectedServiceExecutionAuthorityV1,
  type ConnectedServiceId,
} from '@happier-dev/protocol';

export type ConnectedServiceAuthGroupGenerationTarget = Readonly<{
  serviceId: ConnectedServiceId;
  groupId: string;
  profileId: string;
  generation: number;
  credentialRevision: ConnectedServiceCredentialRevisionV1 | null;
}>;

type ConnectedServiceAuthGroupGenerationTargetInput = Omit<
  ConnectedServiceAuthGroupGenerationTarget,
  'credentialRevision'
> & Readonly<{ credentialRevision?: ConnectedServiceCredentialRevisionV1 | null }>;

export type ConnectedServiceAuthGroupObservedFailureSource = ConnectedServiceAuthGroupGenerationTarget & Readonly<{
  credentialRevision: ConnectedServiceCredentialRevisionV1 | null;
  observedAtMs: number;
  failureKind: string;
}>;

export type ConnectedServiceAuthGroupCommittedGenerationFact = Readonly<{
  decisionId: string;
  provenance: 'manual' | 'hard_limit' | 'soft_threshold' | 'runtime_failure' | 'reconciliation';
  observedFailureSource: ConnectedServiceAuthGroupObservedFailureSource | null;
  requestedTarget: Readonly<{ profileId: string }> | null;
  decisionCommittedTarget: ConnectedServiceAuthGroupGenerationTarget;
}>;

export type ConnectedServiceAuthGroupCommittedGenerationFactInput = Omit<
  ConnectedServiceAuthGroupCommittedGenerationFact,
  'observedFailureSource' | 'requestedTarget' | 'decisionCommittedTarget'
> & Readonly<{
  observedFailureSource?: (Omit<ConnectedServiceAuthGroupObservedFailureSource, 'credentialRevision'> & Readonly<{
    credentialRevision?: ConnectedServiceCredentialRevisionV1 | null;
  }>) | null;
  requestedTarget?: Readonly<{ profileId: string }> | null;
  decisionCommittedTarget: ConnectedServiceAuthGroupGenerationTargetInput;
}>;

export type ConnectedServiceProviderAdoptedGenerationTarget = ConnectedServiceAuthGroupGenerationTarget & Readonly<{
  proof: Readonly<{
    status: 'verified' | 'weakly_verified';
    source: string;
    providerAccountId?: string | null;
    activeAccountId?: string | null;
    sharedAuthSurfaceId?: string | null;
    credentialRevision?: ConnectedServiceCredentialRevisionV1 | null;
    credentialFingerprint?: string | null;
  }>;
}>;

export type ConnectedServiceAuthGenerationReconciliationDisposition =
  | 'converged'
  | 'superseded_after_apply'
  | 'deferred_restart'
  | 'failed';

export type ConnectedServiceGenerationExecutionAuthority = ConnectedServiceExecutionAuthorityV1;

export type ConnectedServiceAuthGenerationApplicationOutcome = Readonly<{
  sessionId: string;
  committedGeneration: ConnectedServiceAuthGroupCommittedGenerationFact;
  normalizedAtApplyTarget: ConnectedServiceAuthGroupGenerationTarget;
  providerAdoptedTarget: ConnectedServiceProviderAdoptedGenerationTarget | null;
  observedAfterApplyTarget: ConnectedServiceAuthGroupGenerationTarget;
  reconciliationDisposition: ConnectedServiceAuthGenerationReconciliationDisposition;
  errorCode: string | null;
}>;

function normalizeNonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`connected_service_auth_generation_${field}_invalid`);
  return normalized;
}

function normalizeGeneration(value: number): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error('connected_service_auth_generation_invalid');
  }
  return value;
}

function normalizeCredentialRevision(value: unknown): ConnectedServiceCredentialRevisionV1 | null {
  if (value === null || value === undefined) return null;
  const parsed = ConnectedServiceCredentialRevisionV1Schema.safeParse(value);
  if (!parsed.success) throw new Error('connected_service_auth_credential_revision_invalid');
  return parsed.data;
}

function normalizeTarget(target: ConnectedServiceAuthGroupGenerationTargetInput): ConnectedServiceAuthGroupGenerationTarget {
  return Object.freeze({
    serviceId: target.serviceId,
    groupId: normalizeNonEmpty(target.groupId, 'group_id'),
    profileId: normalizeNonEmpty(target.profileId, 'profile_id'),
    generation: normalizeGeneration(target.generation),
    credentialRevision: normalizeCredentialRevision(target.credentialRevision),
  });
}

export function buildConnectedServiceAuthGroupTargetEpochIdentity(
  target: ConnectedServiceAuthGroupGenerationTarget,
): string {
  return `${target.serviceId}\0${target.groupId}\0${target.profileId}\0${target.generation}\0${target.credentialRevision ?? 'unknown'}`;
}

function isSameTarget(
  left: ConnectedServiceAuthGroupGenerationTarget,
  right: ConnectedServiceAuthGroupGenerationTarget,
): boolean {
  return left.serviceId === right.serviceId
    && left.groupId === right.groupId
    && left.profileId === right.profileId
    && left.generation === right.generation
    && left.credentialRevision === right.credentialRevision;
}

export function buildConnectedServiceAuthGroupCommittedGenerationFact(
  input: ConnectedServiceAuthGroupCommittedGenerationFactInput,
): ConnectedServiceAuthGroupCommittedGenerationFact {
  const decisionCommittedTarget = normalizeTarget(input.decisionCommittedTarget);
  const observedFailureSource = input.observedFailureSource
    ? Object.freeze({
        ...normalizeTarget(input.observedFailureSource),
        credentialRevision: normalizeCredentialRevision(input.observedFailureSource.credentialRevision),
        observedAtMs: Math.max(0, Math.trunc(input.observedFailureSource.observedAtMs)),
        failureKind: normalizeNonEmpty(input.observedFailureSource.failureKind, 'failure_kind'),
      })
    : null;
  if (
    observedFailureSource
    && (observedFailureSource.serviceId !== decisionCommittedTarget.serviceId
      || observedFailureSource.groupId !== decisionCommittedTarget.groupId)
  ) {
    throw new Error('connected_service_auth_generation_failure_source_scope_mismatch');
  }
  return Object.freeze({
    decisionId: normalizeNonEmpty(input.decisionId, 'decision_id'),
    provenance: input.provenance,
    observedFailureSource,
    requestedTarget: input.requestedTarget
      ? Object.freeze({ profileId: normalizeNonEmpty(input.requestedTarget.profileId, 'requested_profile_id') })
      : null,
    decisionCommittedTarget,
  });
}

export function finalizeConnectedServiceAuthGenerationApplication(input: Readonly<{
  sessionId: string;
  committedGeneration: ConnectedServiceAuthGroupCommittedGenerationFact;
  normalizedAtApplyTarget: ConnectedServiceAuthGroupGenerationTarget;
  providerAdoptedTarget: ConnectedServiceProviderAdoptedGenerationTarget | null;
  observedAfterApplyTarget: ConnectedServiceAuthGroupGenerationTarget;
}>): ConnectedServiceAuthGenerationApplicationOutcome {
  const committedGeneration = buildConnectedServiceAuthGroupCommittedGenerationFact(input.committedGeneration);
  const normalizedAtApplyTarget = normalizeTarget(input.normalizedAtApplyTarget);
  const observedAfterApplyTarget = normalizeTarget(input.observedAfterApplyTarget);
  const providerAdoptedTarget = input.providerAdoptedTarget
    ? Object.freeze({ ...normalizeTarget(input.providerAdoptedTarget), proof: Object.freeze({ ...input.providerAdoptedTarget.proof }) })
    : null;
  const scopeMatches = normalizedAtApplyTarget.serviceId === committedGeneration.decisionCommittedTarget.serviceId
    && normalizedAtApplyTarget.groupId === committedGeneration.decisionCommittedTarget.groupId;
  const desiredCredentialRevision = normalizedAtApplyTarget.credentialRevision;
  const provenCredentialRevision = providerAdoptedTarget?.proof.credentialRevision ?? null;
  const credentialRevisionError = desiredCredentialRevision === null || provenCredentialRevision === null
    ? 'credential_revision_unproven'
    : provenCredentialRevision !== desiredCredentialRevision
      || providerAdoptedTarget?.credentialRevision !== desiredCredentialRevision
      ? 'credential_revision_mismatch'
      : null;
  const disposition: ConnectedServiceAuthGenerationReconciliationDisposition = !scopeMatches || !providerAdoptedTarget || credentialRevisionError
    ? 'failed'
    : isSameTarget(providerAdoptedTarget, observedAfterApplyTarget)
      ? 'converged'
      : 'superseded_after_apply';
  return Object.freeze({
    sessionId: normalizeNonEmpty(input.sessionId, 'session_id'),
    committedGeneration,
    normalizedAtApplyTarget,
    providerAdoptedTarget,
    observedAfterApplyTarget,
    reconciliationDisposition: disposition,
    errorCode: !scopeMatches
      ? 'normalized_target_scope_mismatch'
      : !providerAdoptedTarget
        ? 'provider_adoption_unproven'
        : credentialRevisionError
          ? credentialRevisionError
        : null,
  });
}
