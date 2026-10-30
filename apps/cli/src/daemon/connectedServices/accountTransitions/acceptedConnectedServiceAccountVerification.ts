import type { ConnectedServiceCredentialRevisionV1, ConnectedServiceId } from '@happier-dev/protocol';

import type { ConnectedServiceAccountTransitionVerificationResult } from './connectedServiceAccountTransition';
import { isSameConnectedServiceAccountTarget } from '../sessionAuthSwitch/connectedServiceAuthSwitchOutcome';

export type AcceptedConnectedServiceAccountVerification = Readonly<{
  status: 'verified' | 'weakly_verified';
  providerAccountId?: string | null;
  activeAccountId?: string | null;
  sharedAuthSurfaceId?: string | null;
  credentialRevision?: ConnectedServiceCredentialRevisionV1 | null;
  credentialFingerprint?: string | null;
  generationApplication?: Extract<ConnectedServiceAccountTransitionVerificationResult, { status: 'verified' }>['generationApplication'];
  proofStrength?: 'exact' | 'weak' | 'diagnostic';
  source?: string;
  reason?: string;
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

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
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
  const credentialRevision = result.credentialRevision ?? null;
  const credentialFingerprint = readNonEmptyString(result.credentialFingerprint);
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
          ...(credentialRevision !== null ? { credentialRevision } : {}),
          ...(credentialFingerprint !== null ? { credentialFingerprint } : {}),
          ...(result.generationApplication !== undefined
            ? { generationApplication: result.generationApplication }
            : {}),
        }
      : {}),
    ...(preserveExactProofDetails ? { proofStrength: result.proofStrength } : {}),
    ...(preserveExactProofDetails && result.source ? { source: result.source } : {}),
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

export function hasExactAcceptedConnectedServiceTargetAdoptionProof(input: Readonly<{
  verificationByServiceId: unknown;
  target: Readonly<{
    serviceId: ConnectedServiceId;
    groupId: string;
    profileId: string;
    generation: number;
    credentialRevision: ConnectedServiceCredentialRevisionV1 | null;
  }>;
}>): boolean {
  const verificationByServiceId = readRecord(input.verificationByServiceId);
  const verificationRecord = readRecord(verificationByServiceId?.[input.target.serviceId]);
  const verification = verificationRecord === null
    ? undefined
    : verificationRecord as AcceptedConnectedServiceAccountVerification;
  if (!isExactAcceptedConnectedServiceAccountVerification(verification)) {
    return false;
  }
  const generationApplication = readRecord(verification.generationApplication);
  return generationApplication !== null
    && isSameConnectedServiceAccountTarget(input.target, generationApplication);
}

export function serializeAcceptedConnectedServiceAccountVerifications(
  verificationsByServiceId: ReadonlyMap<ConnectedServiceId, AcceptedConnectedServiceAccountVerification>,
): AcceptedConnectedServiceAccountVerificationByServiceId | undefined {
  if (verificationsByServiceId.size === 0) return undefined;
  return Object.fromEntries(verificationsByServiceId.entries());
}
