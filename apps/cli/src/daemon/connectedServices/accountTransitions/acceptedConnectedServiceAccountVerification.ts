import type { ConnectedServiceId } from '@happier-dev/protocol';

import type { ConnectedServiceAccountTransitionVerificationResult } from '../runtimeAuth/types';

export type AcceptedConnectedServiceAccountVerification = Readonly<{
  status: 'verified' | 'weakly_verified';
  reason?: string;
}>;

export type AcceptedConnectedServiceAccountVerificationByServiceId =
  Readonly<Record<string, AcceptedConnectedServiceAccountVerification>>;

type AcceptedVerificationResult = Extract<
  ConnectedServiceAccountTransitionVerificationResult,
  Readonly<{ status: 'verified' | 'weakly_verified' }>
>;

export function toAcceptedConnectedServiceAccountVerification(
  result: AcceptedVerificationResult,
): AcceptedConnectedServiceAccountVerification {
  return {
    status: result.status,
    ...(result.reason ? { reason: result.reason } : {}),
  };
}

export function serializeAcceptedConnectedServiceAccountVerifications(
  verificationsByServiceId: ReadonlyMap<ConnectedServiceId, AcceptedConnectedServiceAccountVerification>,
): AcceptedConnectedServiceAccountVerificationByServiceId | undefined {
  if (verificationsByServiceId.size === 0) return undefined;
  return Object.fromEntries(verificationsByServiceId.entries());
}
