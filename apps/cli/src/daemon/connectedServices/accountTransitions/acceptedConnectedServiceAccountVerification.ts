import type { ConnectedAccountServiceKey, ConnectedServiceCredentialRevisionV1 } from '@happier-dev/protocol';
import { QualifiedConnectedAccountServiceRefSchema } from '@happier-dev/protocol/connect/qualified-connected-account-projections';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';

import type { ConnectedServiceAccountTransitionVerificationResult } from '../runtimeAuth/types';
import { isSameConnectedServiceAccountTarget, type ConnectedServiceMaterializedTargetsByServiceId, type ConnectedServiceAuthGroupGenerationTarget, type ConnectedServiceProviderAdoptedGenerationTarget } from '../sessionAuthSwitch/connectedServiceAuthSwitchOutcome';

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

function readApplicationServiceKey(value: unknown): string | null {
  if (typeof value === 'string') return value || null;
  const parsed = QualifiedConnectedAccountServiceRefSchema.safeParse(value);
  return parsed.success ? buildQualifiedPluginContributionKey(parsed.data) : null;
}

export function readExactConnectedServiceGenerationApplication(input: Readonly<{
  serviceId: unknown;
  groupId: string;
  profileId: string | null;
  generation: number;
  verificationByServiceId?: AcceptedConnectedServiceAccountVerificationByServiceId;
}>): NonNullable<AcceptedConnectedServiceAccountVerification['generationApplication']> | null {
  const serviceId = readApplicationServiceKey(input.serviceId);
  if (!serviceId) return null;
  const verification = input.verificationByServiceId?.[serviceId];
  if (!isExactAcceptedConnectedServiceAccountVerification(verification)) return null;
  const application = verification.generationApplication;
  return application && isSameConnectedServiceAccountTarget({ ...input, serviceId }, application)
    ? application : null;
}

export function readConnectedServiceApplicationTargetCredentialRevision(input: Parameters<typeof readExactConnectedServiceGenerationApplication>[0] & Readonly<{
  materializedTargetByServiceId?: ConnectedServiceMaterializedTargetsByServiceId;
}>): ConnectedServiceCredentialRevisionV1 | null {
  const verified = readExactConnectedServiceGenerationApplication(input);
  if (verified) return verified.credentialRevision ?? null;
  const serviceId = readApplicationServiceKey(input.serviceId);
  const handedTarget = serviceId ? input.materializedTargetByServiceId?.[serviceId] : undefined;
  return serviceId && handedTarget && isSameConnectedServiceAccountTarget({ ...input, serviceId }, handedTarget)
    ? handedTarget.credentialRevision : null;
}

export function readConnectedServiceProviderAdoptedGenerationTarget(input: Readonly<{
  target: ConnectedServiceAuthGroupGenerationTarget;
  verificationByServiceId?: AcceptedConnectedServiceAccountVerificationByServiceId;
}>): ConnectedServiceProviderAdoptedGenerationTarget | null {
  const application = readExactConnectedServiceGenerationApplication({ ...input.target,
    verificationByServiceId: input.verificationByServiceId });
  if (!application) return null;
  const verification = input.verificationByServiceId?.[input.target.serviceId];
  return {
    ...input.target,
    credentialRevision: application.credentialRevision ?? null,
    proof: {
      status: 'verified', source: verification?.source ?? 'post_switch_verification',
      ...(verification?.providerAccountId === undefined ? {} : { providerAccountId: verification.providerAccountId }),
      ...(verification?.activeAccountId === undefined ? {} : { activeAccountId: verification.activeAccountId }),
      ...(verification?.sharedAuthSurfaceId === undefined ? {} : { sharedAuthSurfaceId: verification.sharedAuthSurfaceId }),
      ...(application.credentialRevision === undefined ? {} : { credentialRevision: application.credentialRevision }),
      ...(application.credentialFingerprint === undefined ? {} : { credentialFingerprint: application.credentialFingerprint }),
    },
  };
}

export function serializeAcceptedConnectedServiceAccountVerifications(
  verificationsByServiceId: ReadonlyMap<ConnectedAccountServiceKey, AcceptedConnectedServiceAccountVerification>,
): AcceptedConnectedServiceAccountVerificationByServiceId | undefined {
  if (verificationsByServiceId.size === 0) return undefined;
  return Object.fromEntries(verificationsByServiceId.entries());
}
