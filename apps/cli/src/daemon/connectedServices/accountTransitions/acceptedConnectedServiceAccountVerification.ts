import type { ConnectedServiceCredentialRevisionV1, ConnectedServiceId } from '@happier-dev/protocol';

import type { ConnectedServiceAccountTransitionVerificationResult } from '../runtimeAuth/types';

export type AcceptedConnectedServiceAccountVerification = Readonly<{
  status: 'verified' | 'weakly_verified';
  providerAccountId?: string | null;
  activeAccountId?: string | null;
  sharedAuthSurfaceId?: string | null;
  proofStrength?: 'exact' | 'weak' | 'diagnostic';
  source?: string;
  reason?: string;
  credentialRevision?: ConnectedServiceCredentialRevisionV1 | null;
  credentialFingerprint?: string | null;
  generationApplication?: Extract<ConnectedServiceAccountTransitionVerificationResult, { status: 'verified' }>['generationApplication'];
}>;

export type AcceptedConnectedServiceAccountVerificationByServiceId =
  Readonly<Record<string, AcceptedConnectedServiceAccountVerification>>;

type AcceptedVerificationResult = Extract<
  ConnectedServiceAccountTransitionVerificationResult,
  Readonly<{ status: 'verified' | 'weakly_verified' }>
>;

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function hasExactIdentityMaterial(
  verification: Readonly<{
    providerAccountId?: string | null;
    activeAccountId?: string | null;
    sharedAuthSurfaceId?: string | null;
  }>,
): boolean {
  return readNonEmptyString(verification.providerAccountId) !== null
    || readNonEmptyString(verification.activeAccountId) !== null
    || readNonEmptyString(verification.sharedAuthSurfaceId) !== null;
}

export function toAcceptedConnectedServiceAccountVerification(
  result: AcceptedVerificationResult,
): AcceptedConnectedServiceAccountVerification {
  const providerAccountId = readNonEmptyString(result.providerAccountId);
  const activeAccountId = readNonEmptyString(result.activeAccountId);
  const sharedAuthSurfaceId = readNonEmptyString(result.sharedAuthSurfaceId);
  const preserveExactProofDetails = result.status === 'verified'
    && result.proofStrength === 'exact'
    && hasExactIdentityMaterial(result);
  return {
    status: result.status,
    ...(preserveExactProofDetails
      ? {
          ...(providerAccountId !== null ? { providerAccountId } : {}),
          ...(activeAccountId !== null ? { activeAccountId } : {}),
          ...(sharedAuthSurfaceId !== null ? { sharedAuthSurfaceId } : {}),
        }
      : {}),
    ...(preserveExactProofDetails ? { proofStrength: result.proofStrength } : {}),
    ...(preserveExactProofDetails && result.source ? { source: result.source } : {}),
    ...(preserveExactProofDetails && result.credentialRevision !== undefined
      ? { credentialRevision: result.credentialRevision }
      : {}),
    ...(preserveExactProofDetails && result.credentialFingerprint !== undefined
      ? { credentialFingerprint: result.credentialFingerprint }
      : {}),
    ...(preserveExactProofDetails && result.generationApplication !== undefined
      ? { generationApplication: result.generationApplication }
      : {}),
    ...(result.reason ? { reason: result.reason } : {}),
  };
}

export function isExactAcceptedConnectedServiceAccountVerification(
  verification: AcceptedConnectedServiceAccountVerification | undefined,
): verification is AcceptedConnectedServiceAccountVerification & Readonly<{
  status: 'verified';
  proofStrength: 'exact';
}> {
  return verification?.status === 'verified'
    && verification.proofStrength === 'exact'
    && hasExactIdentityMaterial(verification);
}

export function serializeAcceptedConnectedServiceAccountVerifications(
  verificationsByServiceId: ReadonlyMap<ConnectedServiceId, AcceptedConnectedServiceAccountVerification>,
): AcceptedConnectedServiceAccountVerificationByServiceId | undefined {
  if (verificationsByServiceId.size === 0) return undefined;
  return Object.fromEntries(verificationsByServiceId.entries());
}
