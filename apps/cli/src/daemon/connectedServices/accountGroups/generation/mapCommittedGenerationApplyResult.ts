import { ConnectedServiceCredentialRevisionV1Schema } from '@happier-dev/protocol';

import {
  buildConnectedServiceAuthGroupCommittedGenerationFact,
  buildConnectedServiceAuthGroupTargetEpochIdentity,
  type ConnectedServiceAuthGenerationReconciliationDisposition,
  type ConnectedServiceAuthGroupCommittedGenerationFact,
  type ConnectedServiceProviderAdoptedGenerationTarget,
} from '../../sessionAuthSwitch/connectedServiceAuthSwitchOutcome';
import {
  isExactAcceptedConnectedServiceAccountVerification,
  type AcceptedConnectedServiceAccountVerificationByServiceId,
} from '../../accountTransitions/acceptedConnectedServiceAccountVerification';

type RawApplyResult = Readonly<{
  status: string;
  activeProfileId?: string | null;
  generation?: number | null;
  credentialRevision?: string | null;
  adoptedCredentialRevision?: string | null;
  errorCode?: string | null;
  mode?: string | null;
  providerApplication?: string | null;
  verificationByServiceId?: AcceptedConnectedServiceAccountVerificationByServiceId;
}>;

export function mapCommittedGenerationApplyResult(input: Readonly<{
  committedGeneration: ConnectedServiceAuthGroupCommittedGenerationFact;
  result: RawApplyResult;
}>): Readonly<{
  reconciliationDisposition: ConnectedServiceAuthGenerationReconciliationDisposition;
  errorCode: string | null;
  authoritativeGeneration?: ConnectedServiceAuthGroupCommittedGenerationFact;
  providerAdoptedTarget?: ConnectedServiceProviderAdoptedGenerationTarget;
  restartRequested?: boolean;
}> {
  if (input.result.status === 'switched' || input.result.status === 'observed_generation') {
    const target = input.committedGeneration.decisionCommittedTarget;
    const profileId = typeof input.result.activeProfileId === 'string' ? input.result.activeProfileId.trim() : '';
    const generation = typeof input.result.generation === 'number' && Number.isInteger(input.result.generation)
      ? input.result.generation
      : null;
    const verification = input.result.verificationByServiceId?.[target.serviceId];
    const exactVerification = isExactAcceptedConnectedServiceAccountVerification(verification);
    const generationApplication = verification?.generationApplication;
    const exactGenerationApplication = generationApplication !== undefined && (
      generationApplication.serviceId === target.serviceId
      && generationApplication.groupId === target.groupId
      && generationApplication.profileId === target.profileId
      && generationApplication.generation === target.generation
      && generationApplication.credentialRevision === target.credentialRevision
    );
    if (
      input.result.providerApplication !== 'applied'
      || !exactVerification
      || !exactGenerationApplication
      || profileId !== target.profileId
      || generation !== target.generation
    ) {
      return {
        reconciliationDisposition: 'deferred_restart',
        errorCode: null,
        restartRequested: input.result.mode === 'restart_resume',
      };
    }
    return {
      reconciliationDisposition: 'converged',
      errorCode: null,
      providerAdoptedTarget: {
        ...target,
        proof: {
          status: 'verified',
          source: verification?.source ?? 'post_switch_verification',
          ...(verification?.providerAccountId === undefined
            ? {}
            : { providerAccountId: verification.providerAccountId }),
          ...(verification?.activeAccountId === undefined
            ? {}
            : { activeAccountId: verification.activeAccountId }),
          ...(verification?.sharedAuthSurfaceId === undefined
            ? {}
            : { sharedAuthSurfaceId: verification.sharedAuthSurfaceId }),
          ...(generationApplication.credentialRevision === undefined
            ? {}
            : { credentialRevision: generationApplication.credentialRevision }),
          ...(generationApplication.credentialFingerprint === undefined
            ? {}
            : { credentialFingerprint: generationApplication.credentialFingerprint }),
        },
      },
    };
  }
  if (input.result.status === 'superseded_after_apply') {
    const activeProfileId = typeof input.result.activeProfileId === 'string'
      ? input.result.activeProfileId.trim()
      : '';
    const generation = typeof input.result.generation === 'number'
      && Number.isInteger(input.result.generation)
      && input.result.generation >= 0
      ? input.result.generation
      : null;
    if (!activeProfileId || generation === null) {
      return { reconciliationDisposition: 'failed', errorCode: 'superseded_authoritative_generation_missing' };
    }
    const target = input.committedGeneration.decisionCommittedTarget;
    const revisionRequired = generation === target.generation && target.credentialRevision !== null;
    const credentialRevision = input.result.credentialRevision == null
      ? null
      : ConnectedServiceCredentialRevisionV1Schema.safeParse(input.result.credentialRevision);
    if ((revisionRequired && credentialRevision === null) || (credentialRevision !== null && !credentialRevision.success)) {
      return { reconciliationDisposition: 'failed', errorCode: 'superseded_authoritative_revision_missing' };
    }
    const decisionCommittedTarget = {
      serviceId: target.serviceId,
      groupId: target.groupId,
      profileId: activeProfileId,
      generation,
      credentialRevision: credentialRevision === null ? null : credentialRevision.data,
    } as const;
    return {
      reconciliationDisposition: 'superseded_after_apply',
      errorCode: null,
      authoritativeGeneration: buildConnectedServiceAuthGroupCommittedGenerationFact({
        decisionId: buildConnectedServiceAuthGroupTargetEpochIdentity(decisionCommittedTarget),
        provenance: 'reconciliation',
        requestedTarget: { profileId: activeProfileId },
        decisionCommittedTarget,
      }),
    };
  }
  if (input.result.errorCode === 'restart_disallowed_by_execution_policy') {
    return {
      reconciliationDisposition: 'deferred_restart',
      errorCode: 'restart_disallowed_by_execution_policy',
      restartRequested: false,
    };
  }
  if (input.result.status === 'deferred' || input.result.status === 'deferred_restart') {
    return {
      reconciliationDisposition: 'deferred_restart',
      errorCode: input.result.errorCode ?? null,
      restartRequested: false,
    };
  }
  return {
    reconciliationDisposition: 'failed',
    errorCode: input.result.errorCode ?? 'committed_generation_apply_failed',
  };
}
