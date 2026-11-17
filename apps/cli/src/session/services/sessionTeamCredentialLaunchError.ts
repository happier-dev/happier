import { ProviderBrokerAdmissionFailureCodeV1Schema } from '@happier-dev/protocol/providers/brokerRouteGrantV1';
import { TeamCredentialBrokerApplicationFailureCodeV1Schema, type TeamCredentialBrokerApplicationFailureCodeV1 } from '@happier-dev/protocol/teams/credentials/externalProviderApiV1';
import { ConnectedServiceUxDiagnosticCodeV1Schema, type ConnectedServiceUxDiagnosticCodeV1 } from '@happier-dev/protocol/connect/connectedServiceUxDiagnostics';
import { projectSessionRuntimeFailureCause, readSessionPreparationFailureCode, type SessionPreparationFailureCode, type SessionRuntimeIssueV1 } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';
import { isActionOutcomeUnknownErrorCodeV1, UNEXPECTED_ACTION_FAILURE_CODES_V1 } from '@happier-dev/protocol/actions/actionExecutionResult';

export type TeamCredentialLaunchFailureCode = TeamCredentialBrokerApplicationFailureCodeV1
  | ConnectedServiceUxDiagnosticCodeV1 | SessionPreparationFailureCode;

/** Owner-local diagnostic locations; never launch options or provider content. */
export type TeamCredentialLaunchFailurePhase = 'binding' | 'agent_requirements' | 'teams_catalog'
  | 'resource_catalog' | 'catalog_revision' | 'connected_services' | 'agent_target'
  | 'resource_selection' | 'purpose_binding' | 'model_source' | 'model_selection' | 'model_catalog' | 'readiness';

function readCode(value: unknown): TeamCredentialLaunchFailureCode | null {
  if (typeof value !== 'string') return null;
  if (isActionOutcomeUnknownErrorCodeV1(value)) return UNEXPECTED_ACTION_FAILURE_CODES_V1[1];
  const broker = TeamCredentialBrokerApplicationFailureCodeV1Schema.safeParse(value);
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
  readonly failureCause: NonNullable<SessionRuntimeIssueV1['failureCause']>;

  // Binding/open guards without a lower-level reason retain the established selection code.
  // Launch and catalog decisions always supply their exact code and phase.
  constructor(readonly code: TeamCredentialLaunchFailureCode = 'team_credential_provider_selection_not_current',
    readonly phase: TeamCredentialLaunchFailurePhase = 'binding', cause?: unknown) {
    super(`The Team credential could not be used (${code}). Choose an available credential for this Session.`);
    // The runner may fail before its webhook. Its existing stderr cause record
    // must retain this closed refusal independently of the process exit code.
    this.failureCause = { code, phase: 'authentication', failureReason: 'unknown',
      // A refusal is itself a typed decision, even without a nested exception.
      // The daemon's Action carrier consumes this cause rather than the runtime envelope.
      actionCause: { phase: `providers.team_credential.${phase}`, errorClass: 'Error', errorCode: code, httpStatus: null },
      ...projectSessionRuntimeFailureCause(cause, 'authentication') };
    if (ProviderBrokerAdmissionFailureCodeV1Schema.safeParse(code).success) {
      this.details = { v: 1, source: 'team_credential' };
    }
  }
}

export function projectTeamCredentialLaunchFailure(error: unknown, phase: TeamCredentialLaunchFailurePhase,
  fallback: TeamCredentialLaunchFailureCode): SessionTeamCredentialLaunchUnavailableError {
  if (error instanceof Error && error.name === 'AbortError') throw error;
  return error instanceof SessionTeamCredentialLaunchUnavailableError ? error
    : new SessionTeamCredentialLaunchUnavailableError(readTeamCredentialLaunchFailureCode(error) ?? fallback, phase, error);
}
