import {
  ConnectedServiceCredentialRevisionV1Schema,
  type ConnectedServiceId,
} from '@happier-dev/protocol';

import {
  buildConnectedServiceAuthGroupCommittedGenerationFact,
  buildConnectedServiceAuthGroupTargetEpochIdentity,
  type ConnectedServiceAuthGroupCommittedGenerationFact,
} from './connectedServiceAuthSwitchOutcome';
import { hasExactAcceptedConnectedServiceTargetAdoptionProof } from '../accountTransitions/acceptedConnectedServiceAccountVerification';

export type ResolvedRuntimeAuthRecoveryCommittedGeneration = Readonly<{
  committedGeneration: ConnectedServiceAuthGroupCommittedGenerationFact;
  sourceRequiresConvergence: boolean;
}>;

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

export function resolveCommittedGenerationFromRuntimeAuthRecovery(input: Readonly<{
  serviceId: ConnectedServiceId;
  groupId: string;
  recovery: unknown;
  provenance?: ConnectedServiceAuthGroupCommittedGenerationFact['provenance'];
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
  const hasExactMatchingAdoptionProof = hasExactAcceptedConnectedServiceTargetAdoptionProof({
    verificationByServiceId: result.verificationByServiceId,
    target: decisionCommittedTarget,
  });

  return Object.freeze({
    committedGeneration: buildConnectedServiceAuthGroupCommittedGenerationFact({
      decisionId: buildConnectedServiceAuthGroupTargetEpochIdentity(decisionCommittedTarget),
      provenance: input.provenance ?? 'hard_limit',
      decisionCommittedTarget,
    }),
    sourceRequiresConvergence: status === 'superseded_after_apply' || !hasExactMatchingAdoptionProof,
  });
}
