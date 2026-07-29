import {
  ConnectedServiceCredentialRevisionV1Schema,
  type ConnectedServiceId,
} from '@happier-dev/protocol';

import {
  buildConnectedServiceAuthGroupCommittedGenerationFact,
  buildConnectedServiceAuthGroupTargetEpochIdentity,
  type ConnectedServiceAuthGroupCommittedGenerationFact,
} from './connectedServiceAuthSwitchOutcome';

export type ResolvedRuntimeAuthRecoveryCommittedGeneration = Readonly<{
  committedGeneration: ConnectedServiceAuthGroupCommittedGenerationFact;
  sourceRequiresConvergence: boolean;
}>;

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

export function hasExactConnectedServiceTargetAdoptionProof(input: Readonly<{
  serviceId: ConnectedServiceId;
  target: Readonly<{ groupId: string; profileId: string; generation: number; credentialRevision: string | null }>;
  outcome: unknown;
}>): boolean {
  const outcome = asRecord(input.outcome);
  const verificationByServiceId = asRecord(outcome?.verificationByServiceId);
  const verification = asRecord(verificationByServiceId?.[input.serviceId]);
  const generationApplication = asRecord(verification?.generationApplication);
  const hasExactIdentity = typeof verification?.providerAccountId === 'string' && verification.providerAccountId.trim().length > 0
    || typeof verification?.activeAccountId === 'string' && verification.activeAccountId.trim().length > 0
    || typeof verification?.sharedAuthSurfaceId === 'string' && verification.sharedAuthSurfaceId.trim().length > 0;
  return verification?.status === 'verified'
    && verification.proofStrength === 'exact'
    && hasExactIdentity
    && generationApplication !== null
    && generationApplication.serviceId === input.serviceId
    && generationApplication.groupId === input.target.groupId
    && generationApplication.profileId === input.target.profileId
    && generationApplication.generation === input.target.generation
    && generationApplication.credentialRevision === input.target.credentialRevision;
}

export function resolveCommittedGenerationFromRuntimeAuthRecovery(input: Readonly<{
  serviceId: ConnectedServiceId;
  groupId: string;
  recovery: unknown;
}>): ResolvedRuntimeAuthRecoveryCommittedGeneration | null {
  const recovery = asRecord(input.recovery);
  if (recovery?.status !== 'switch_attempted') return null;
  const result = asRecord(recovery.result);
  if (!result) return null;
  const status = result?.status;
  if (status !== 'switched' && status !== 'observed_generation' && status !== 'superseded_after_apply') {
    return null;
  }
  const profileId = typeof result.activeProfileId === 'string' ? result.activeProfileId.trim() : '';
  const generation = result.generation;
  const groupId = input.groupId.trim();
  if (!profileId || !groupId || !Number.isInteger(generation) || (generation as number) < 0) return null;
  const credentialRevision = result.credentialRevision === null || result.credentialRevision === undefined
    ? null
    : ConnectedServiceCredentialRevisionV1Schema.safeParse(result.credentialRevision);
  if (credentialRevision !== null && !credentialRevision.success) return null;
  const decisionCommittedTarget = {
    serviceId: input.serviceId,
    groupId,
    profileId,
    generation: generation as number,
    credentialRevision: credentialRevision === null ? null : credentialRevision.data,
  } as const;
  const hasExactMatchingAdoptionProof = hasExactConnectedServiceTargetAdoptionProof({
    serviceId: input.serviceId,
    target: decisionCommittedTarget,
    outcome: result,
  });

  return Object.freeze({
    committedGeneration: buildConnectedServiceAuthGroupCommittedGenerationFact({
      decisionId: buildConnectedServiceAuthGroupTargetEpochIdentity(decisionCommittedTarget),
      provenance: 'hard_limit',
      decisionCommittedTarget,
    }),
    sourceRequiresConvergence: status === 'superseded_after_apply' || !hasExactMatchingAdoptionProof,
  });
}
