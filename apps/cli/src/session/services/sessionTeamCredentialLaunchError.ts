import { ProviderBrokerAdmissionFailureCodeV1Schema, type ProviderBrokerAdmissionFailureCodeV1 } from '@happier-dev/protocol/providers/brokerRouteGrantV1';
import { ProviderErrorCodeV1Schema, type ProviderErrorCodeV1 } from '@happier-dev/protocol/providers/errors';
import { ConnectedServiceUxDiagnosticCodeV1Schema, type ConnectedServiceUxDiagnosticCodeV1 } from '@happier-dev/protocol/connect/connectedServiceUxDiagnostics';
import { readSessionPreparationFailureCode, type SessionPreparationFailureCode } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';
import { isActionOutcomeUnknownErrorCodeV1, UNEXPECTED_ACTION_FAILURE_CODES_V1 } from '@happier-dev/protocol/actions/actionExecutionResult';

export type TeamCredentialLaunchFailureCode = ProviderBrokerAdmissionFailureCodeV1 | ProviderErrorCodeV1
  | ConnectedServiceUxDiagnosticCodeV1 | SessionPreparationFailureCode;

/** Owner-local diagnostic locations; never launch options or provider content. */
export type TeamCredentialLaunchFailurePhase = 'binding' | 'agent_requirements' | 'teams_catalog'
  | 'resource_catalog' | 'catalog_revision' | 'connected_services' | 'agent_target'
  | 'resource_selection' | 'purpose_binding' | 'model_source' | 'model_selection' | 'model_catalog' | 'readiness';

function readCode(value: unknown): TeamCredentialLaunchFailureCode | null {
  if (typeof value !== 'string') return null;
  if (isActionOutcomeUnknownErrorCodeV1(value)) return UNEXPECTED_ACTION_FAILURE_CODES_V1[1];
  const provider = ProviderErrorCodeV1Schema.safeParse(value);
  if (provider.success) return provider.data;
  const broker = ProviderBrokerAdmissionFailureCodeV1Schema.safeParse(value);
  if (broker.success) return broker.data;
  const connected = ConnectedServiceUxDiagnosticCodeV1Schema.safeParse(value);
  return connected.success ? connected.data : readSessionPreparationFailureCode(value);
}

/** Read closed codes from the existing Action, broker and thrown-error envelopes. */
export function readTeamCredentialLaunchFailureCode(value: unknown): TeamCredentialLaunchFailureCode | null {
  if (!value || typeof value !== 'object') return readCode(value);
  for (const key of ['code', 'errorCode', 'reasonCode', 'reason'] as const) {
    const code = readCode(Reflect.get(value, key));
    if (code) return code;
  }
  const error = Reflect.get(value, 'error');
  if (typeof error === 'string') return readCode(error);
  if (error && typeof error === 'object') {
    return readCode(Reflect.get(error, 'code')) ?? readCode(Reflect.get(error, 'reasonCode'));
  }
  return null;
}

export class SessionTeamCredentialLaunchUnavailableError extends Error {
  readonly details?: Readonly<{ v: 1; source: 'team_credential' }>;

  // Binding/open guards without a lower-level reason retain the established selection code.
  // Launch and catalog decisions always supply their exact code and phase.
  constructor(readonly code: TeamCredentialLaunchFailureCode = 'team_credential_provider_selection_not_current',
    readonly phase: TeamCredentialLaunchFailurePhase = 'binding') {
    super(code);
    if (ProviderBrokerAdmissionFailureCodeV1Schema.safeParse(code).success) {
      this.details = { v: 1, source: 'team_credential' };
    }
  }
}

export function projectTeamCredentialLaunchFailure(error: unknown, phase: TeamCredentialLaunchFailurePhase,
  fallback: TeamCredentialLaunchFailureCode): SessionTeamCredentialLaunchUnavailableError {
  if (error instanceof Error && error.name === 'AbortError') throw error;
  return error instanceof SessionTeamCredentialLaunchUnavailableError ? error
    : new SessionTeamCredentialLaunchUnavailableError(readTeamCredentialLaunchFailureCode(error) ?? fallback, phase);
}
