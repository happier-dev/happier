import { CONNECTED_SERVICE_UX_DIAGNOSTIC_ACTIONS, CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES, ConnectedServiceUxDiagnosticV1Schema } from '@happier-dev/protocol/connect/connectedServiceUxDiagnostics';
import type { ConnectedServiceUxDiagnosticCodeV1, ConnectedServiceUxDiagnosticFailurePhaseV1, ConnectedServiceUxDiagnosticSourceV1, ConnectedServiceUxDiagnosticV1 } from '@happier-dev/protocol';

export function resolveConnectedServiceUxDiagnosticActions(
  code: ConnectedServiceUxDiagnosticCodeV1,
  retryable: boolean,
): ReadonlyArray<ConnectedServiceUxDiagnosticV1['suggestedActions'][number]> {
  switch (code) {
    case CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.continuityUnsupported:
    case CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.providerSessionStateUnavailableForResume:
    case CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.connectedServiceMaterializationIdentityMissing:
    case CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.resumeReachabilityInputsMissing:
      return [
        CONNECTED_SERVICE_UX_DIAGNOSTIC_ACTIONS.startFreshUnderSelectedAccount,
        CONNECTED_SERVICE_UX_DIAGNOSTIC_ACTIONS.resumeCurrentAccount,
        CONNECTED_SERVICE_UX_DIAGNOSTIC_ACTIONS.openConnectedAccounts,
      ];
    case CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.noEligibleGroupMember:
      return [
        CONNECTED_SERVICE_UX_DIAGNOSTIC_ACTIONS.openConnectedAccounts,
        CONNECTED_SERVICE_UX_DIAGNOSTIC_ACTIONS.reconnectProfile,
      ];
    case CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.metadataUpdateFailed:
    case CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.recoveryRetryScheduled:
    case CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.connectedServiceCredentialRefreshUnavailable:
      return [
        CONNECTED_SERVICE_UX_DIAGNOSTIC_ACTIONS.retry,
        CONNECTED_SERVICE_UX_DIAGNOSTIC_ACTIONS.openConnectedAccounts,
      ];
    case CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.recoveryDeadLettered:
      return [
        CONNECTED_SERVICE_UX_DIAGNOSTIC_ACTIONS.retry,
        CONNECTED_SERVICE_UX_DIAGNOSTIC_ACTIONS.openConnectedAccounts,
        CONNECTED_SERVICE_UX_DIAGNOSTIC_ACTIONS.reconnectProfile,
      ];
    case CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.connectedServiceCredentialScopeMissing:
    case CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.connectedServiceNativeAuthMaterializationFailed:
    case CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.connectedServiceCredentialModeUnsupported:
    case CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.connectedServiceCredentialReconnectRequired:
      return [
        CONNECTED_SERVICE_UX_DIAGNOSTIC_ACTIONS.reconnectProfile,
        CONNECTED_SERVICE_UX_DIAGNOSTIC_ACTIONS.openConnectedAccounts,
      ];
    case CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.providerAccountAdoptionMismatch:
    case CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.postSwitchVerificationFailed:
      return retryable
        ? [
            CONNECTED_SERVICE_UX_DIAGNOSTIC_ACTIONS.retry,
            CONNECTED_SERVICE_UX_DIAGNOSTIC_ACTIONS.startFreshUnderSelectedAccount,
            CONNECTED_SERVICE_UX_DIAGNOSTIC_ACTIONS.openConnectedAccounts,
          ]
        : [
            CONNECTED_SERVICE_UX_DIAGNOSTIC_ACTIONS.openConnectedAccounts,
            CONNECTED_SERVICE_UX_DIAGNOSTIC_ACTIONS.reconnectProfile,
          ];
  }
}

export function buildConnectedServiceUxDiagnostic(input: Readonly<{
  code: ConnectedServiceUxDiagnosticCodeV1;
  failurePhase: ConnectedServiceUxDiagnosticFailurePhaseV1;
  source: ConnectedServiceUxDiagnosticSourceV1;
  serviceId?: string;
  agentId?: string;
  profileId?: string | null;
  groupId?: string | null;
  retryable: boolean;
  suggestedActions?: ReadonlyArray<ConnectedServiceUxDiagnosticV1['suggestedActions'][number]>;
  diagnostics?: Readonly<NonNullable<ConnectedServiceUxDiagnosticV1['diagnostics']>>;
}>): ConnectedServiceUxDiagnosticV1 {
  let code = input.code;
  if (code === CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.providerSessionStateUnavailableForResume) {
    switch (input.diagnostics?.reason) {
      case CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.connectedServiceMaterializationIdentityMissing:
      case CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.resumeReachabilityInputsMissing:
        code = input.diagnostics.reason;
    }
  }
  return ConnectedServiceUxDiagnosticV1Schema.parse({
    code,
    failurePhase: input.failurePhase,
    source: input.source,
    ...(input.serviceId ? { serviceId: input.serviceId } : {}),
    ...(input.agentId ? { agentId: input.agentId } : {}),
    ...(input.profileId ? { profileId: input.profileId } : {}),
    ...(input.groupId ? { groupId: input.groupId } : {}),
    retryable: input.retryable,
    suggestedActions: input.suggestedActions ?? resolveConnectedServiceUxDiagnosticActions(code, input.retryable),
    ...(input.diagnostics ? { diagnostics: input.diagnostics } : {}),
  });
}
