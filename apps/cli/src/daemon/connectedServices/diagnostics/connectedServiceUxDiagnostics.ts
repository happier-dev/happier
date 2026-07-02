import {
  CONNECTED_SERVICE_UX_DIAGNOSTIC_ACTIONS,
  CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES,
  ConnectedServiceUxDiagnosticV1Schema,
  type ConnectedServiceUxDiagnosticCodeV1,
  type ConnectedServiceUxDiagnosticFailurePhaseV1,
  type ConnectedServiceUxDiagnosticSourceV1,
  type ConnectedServiceUxDiagnosticV1,
} from '@happier-dev/protocol';

type DiagnosticScalar = string | number | boolean | null;

export function resolveConnectedServiceUxDiagnosticActions(
  code: ConnectedServiceUxDiagnosticCodeV1,
  retryable: boolean,
): ReadonlyArray<ConnectedServiceUxDiagnosticV1['suggestedActions'][number]> {
  switch (code) {
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
    case CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.claudeSubscriptionMissingClaudeCodeScope:
    case CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.claudeSubscriptionNativeAuthMaterializationFailed:
    case CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.claudeSubscriptionSetupTokenNotSupportedForUnified:
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
  providerId?: string;
  agentId?: string;
  profileId?: string | null;
  groupId?: string | null;
  retryable: boolean;
  suggestedActions?: ReadonlyArray<ConnectedServiceUxDiagnosticV1['suggestedActions'][number]>;
  diagnostics?: Readonly<Record<string, DiagnosticScalar>>;
}>): ConnectedServiceUxDiagnosticV1 {
  return ConnectedServiceUxDiagnosticV1Schema.parse({
    code: input.code,
    failurePhase: input.failurePhase,
    source: input.source,
    ...(input.serviceId ? { serviceId: input.serviceId } : {}),
    ...(input.providerId ? { providerId: input.providerId } : {}),
    ...(input.agentId ? { agentId: input.agentId } : {}),
    ...(input.profileId ? { profileId: input.profileId } : {}),
    ...(input.groupId ? { groupId: input.groupId } : {}),
    retryable: input.retryable,
    suggestedActions: input.suggestedActions ?? resolveConnectedServiceUxDiagnosticActions(input.code, input.retryable),
    ...(input.diagnostics ? { diagnostics: input.diagnostics } : {}),
  });
}
