import type {
  ConnectedServiceBindingsV1,
  ConnectedServiceId,
  ConnectedServiceUxDiagnosticV1,
} from '@happier-dev/protocol';

import type { CatalogAgentId } from '@/agent/catalog/ids';
import type { TrackedSession } from '@/daemon/types';
import {
  isExactAcceptedConnectedServiceAccountVerification,
  serializeAcceptedConnectedServiceAccountVerifications,
  toAcceptedConnectedServiceAccountVerification,
  type AcceptedConnectedServiceAccountVerification,
  type AcceptedConnectedServiceAccountVerificationByServiceId,
} from '../../accountTransitions/acceptedConnectedServiceAccountVerification';
import type { ConnectedServiceAccountTransitionVerificationResult } from '../../runtimeAuth/types';

export type PostSwitchVerificationEffectiveBinding = Readonly<{
  source: 'native' | 'connected';
  selection: 'native' | 'profile' | 'group';
  serviceId: ConnectedServiceId;
  profileId: string | null;
  groupId: string | null;
}>;

export type RuntimeAuthSelectionsByServiceId = ReadonlyMap<ConnectedServiceId, unknown>;

export type PostSwitchVerificationMode = Readonly<{
  kind: 'disabled_for_test_only';
  reason: string;
}>;

export type PostSwitchVerificationFailureInput = Readonly<{
  serviceId: ConnectedServiceId;
  result: Exclude<
    ConnectedServiceAccountTransitionVerificationResult,
    Readonly<{ status: 'verified' | 'weakly_verified' }>
  >;
  diagnosticSource: ConnectedServiceUxDiagnosticV1['source'];
  attemptedAction: 'hot_applied' | 'restart_requested';
}>;

export type PostSwitchVerificationOutcome<TFailure> = Readonly<{
  failure: TFailure | null;
  verificationByServiceId?: AcceptedConnectedServiceAccountVerificationByServiceId;
}>;

function spreadPostSwitchVerification(
  outcome: Pick<PostSwitchVerificationOutcome<unknown>, 'verificationByServiceId'>,
): Readonly<{ verificationByServiceId?: AcceptedConnectedServiceAccountVerificationByServiceId }> {
  return outcome.verificationByServiceId && Object.keys(outcome.verificationByServiceId).length > 0
    ? { verificationByServiceId: outcome.verificationByServiceId }
    : {};
}

function isAcceptedAccountTransitionVerification(
  result: ConnectedServiceAccountTransitionVerificationResult,
): result is Extract<ConnectedServiceAccountTransitionVerificationResult, Readonly<{ status: 'verified' | 'weakly_verified' }>> {
  return result.status === 'verified' || result.status === 'weakly_verified';
}

export async function runPostSwitchVerification<TFailure>(input: Readonly<{
  verifyProviderAccountAdoption?: (input: Readonly<{
    tracked: TrackedSession;
    sessionId: string;
    agentId: CatalogAgentId;
    serviceId: ConnectedServiceId;
    target: Readonly<{
      serviceId: ConnectedServiceId;
      profileId: string | null;
      groupId?: string | null;
    }>;
    normalizedBindings: ConnectedServiceBindingsV1;
    action: 'hot_applied' | 'restart_requested';
    runtimeAuthSelection?: unknown;
  }>) => Promise<ConnectedServiceAccountTransitionVerificationResult>;
  postSwitchVerificationMode?: PostSwitchVerificationMode;
  diagnosticSource: ConnectedServiceUxDiagnosticV1['source'];
  tracked: TrackedSession;
  sessionId: string;
  agentId: CatalogAgentId;
  normalizedBindings: ConnectedServiceBindingsV1;
  nextByServiceId: ReadonlyMap<ConnectedServiceId, PostSwitchVerificationEffectiveBinding>;
  serviceIds: ReadonlySet<ConnectedServiceId>;
  action: 'hot_applied' | 'restart_requested';
  acceptedVerificationByServiceId?: AcceptedConnectedServiceAccountVerificationByServiceId;
  runtimeAuthSelectionsByServiceId?: RuntimeAuthSelectionsByServiceId;
  buildVerificationFailure(input: PostSwitchVerificationFailureInput): TFailure;
}>): Promise<PostSwitchVerificationOutcome<TFailure>> {
  const acceptedVerificationsByServiceId = new Map<ConnectedServiceId, AcceptedConnectedServiceAccountVerification>();
  for (const serviceId of input.serviceIds) {
    const accepted = input.acceptedVerificationByServiceId?.[serviceId];
    if (isExactAcceptedConnectedServiceAccountVerification(accepted)) {
      acceptedVerificationsByServiceId.set(serviceId, accepted);
    }
  }
  if (!input.verifyProviderAccountAdoption) {
    if (input.postSwitchVerificationMode?.kind === 'disabled_for_test_only') {
      return {
        failure: null,
        ...spreadPostSwitchVerification({
          verificationByServiceId: serializeAcceptedConnectedServiceAccountVerifications(acceptedVerificationsByServiceId),
        }),
      };
    }
    for (const serviceId of input.serviceIds) {
      const target = input.nextByServiceId.get(serviceId);
      if (!target || target.source !== 'connected') continue;
      if (acceptedVerificationsByServiceId.has(serviceId)) continue;
      return {
        failure: input.buildVerificationFailure({
          serviceId,
          diagnosticSource: input.diagnosticSource,
          attemptedAction: input.action,
          result: {
            status: 'unavailable',
            retryable: false,
            reason: 'post_switch_verifier_missing',
          },
        }),
        ...spreadPostSwitchVerification({
          verificationByServiceId: serializeAcceptedConnectedServiceAccountVerifications(acceptedVerificationsByServiceId),
        }),
      };
    }
    return {
      failure: null,
      ...spreadPostSwitchVerification({
        verificationByServiceId: serializeAcceptedConnectedServiceAccountVerifications(acceptedVerificationsByServiceId),
      }),
    };
  }
  for (const serviceId of input.serviceIds) {
    const target = input.nextByServiceId.get(serviceId);
    if (!target || target.source !== 'connected') continue;
    if (acceptedVerificationsByServiceId.has(serviceId)) continue;
    let verification: ConnectedServiceAccountTransitionVerificationResult;
    try {
      verification = await input.verifyProviderAccountAdoption({
        tracked: input.tracked,
        sessionId: input.sessionId,
        agentId: input.agentId,
        serviceId,
        target: {
          serviceId,
          profileId: target.profileId,
          ...(target.groupId ? { groupId: target.groupId } : {}),
        },
        normalizedBindings: input.normalizedBindings,
        action: input.action,
        ...(input.runtimeAuthSelectionsByServiceId?.has(serviceId)
          ? { runtimeAuthSelection: input.runtimeAuthSelectionsByServiceId.get(serviceId) }
          : {}),
      });
    } catch {
      verification = {
        status: 'unavailable',
        retryable: true,
        reason: 'active_account_verification_threw',
      };
    }
    if (isAcceptedAccountTransitionVerification(verification)) {
      acceptedVerificationsByServiceId.set(
        serviceId,
        toAcceptedConnectedServiceAccountVerification(verification),
      );
      continue;
    }
    return {
      failure: input.buildVerificationFailure({
        serviceId,
        result: verification,
        diagnosticSource: input.diagnosticSource,
        attemptedAction: input.action,
      }),
      ...spreadPostSwitchVerification({
        verificationByServiceId: serializeAcceptedConnectedServiceAccountVerifications(acceptedVerificationsByServiceId),
      }),
    };
  }
  return {
    failure: null,
    ...spreadPostSwitchVerification({
      verificationByServiceId: serializeAcceptedConnectedServiceAccountVerifications(acceptedVerificationsByServiceId),
    }),
  };
}
