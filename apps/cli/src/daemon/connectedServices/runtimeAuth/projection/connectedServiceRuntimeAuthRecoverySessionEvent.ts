import type { ConnectedServiceRuntimeFailureClassification } from '../types';
import type { ConnectedServiceRuntimeAuthFailureDaemonReport } from '../reportConnectedServiceRuntimeAuthFailureToDaemon';
import type { ConnectedServiceRuntimeAuthRecoveryProjection } from './connectedServiceRuntimeAuthRecoveryProjection';

export type ConnectedServiceRuntimeAuthRecoveryProjectionResult = Readonly<{
  statusMessageAdded: boolean;
  genericMessageEmitted: boolean;
  typedProjectionCommitted: boolean;
  requiresFallback: boolean;
  emitted: boolean;
}>;

const NON_TERMINAL_RUNTIME_AUTH_RECOVERY_STATUS_CODES = new Set([
  'credential_refreshed_restart_requested',
  'credential_refreshed_awaiting_provider_outcome',
  'recovery_retry_scheduled',
  'temporary_retry_armed',
  'switch_attempted_no_eligible_member',
  'switch_attempted_switch_limit_reached',
]);

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function readNonEmptyString(value: unknown): string | null {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized.length > 0 ? normalized : null;
}

export function connectedServiceRuntimeAuthRecoveryWillContinue(recoveryReport: unknown): boolean {
  const report = readRecord(recoveryReport);
  if (!report) return false;
  if (report.handled !== true) return false;

  const projection = readRecord(report.projection);
  if (projection?.terminal === true) return false;

  const uxDiagnostic = readRecord(report.uxDiagnostic) ?? readRecord(projection?.uxDiagnostic);
  if (uxDiagnostic?.retryable === true) return true;

  const statusCode = readNonEmptyString(report.statusCode);
  return statusCode !== null && NON_TERMINAL_RUNTIME_AUTH_RECOVERY_STATUS_CODES.has(statusCode);
}

export function projectConnectedServiceRuntimeAuthRecoveryReport(input: Readonly<{
  report: ConnectedServiceRuntimeAuthFailureDaemonReport;
  classification?: ConnectedServiceRuntimeFailureClassification;
  addStatusMessage?: (message: string) => boolean | void;
  sendGenericStatusMessage?: (message: string) => boolean | void;
  commitTypedProjection?: (projection: ConnectedServiceRuntimeAuthRecoveryProjection) => boolean | void;
}>): ConnectedServiceRuntimeAuthRecoveryProjectionResult {
  const statusMessage = input.report.statusMessage;
  const projection = input.report.projection;
  let statusMessageAdded = false;
  let genericMessageEmitted = false;
  let typedProjectionCommitted = false;

  const hasTypedProjection = Boolean(projection?.uxDiagnostic || projection?.transcriptEvent);
  const daemonHandledTranscriptProjection = Boolean(input.report.handled && projection?.transcriptEvent);

  if (statusMessage && !daemonHandledTranscriptProjection) {
    const result = input.addStatusMessage?.(statusMessage);
    statusMessageAdded = result === false ? false : Boolean(input.addStatusMessage);
  }

  if (projection && hasTypedProjection && input.commitTypedProjection && !daemonHandledTranscriptProjection) {
    const result = input.commitTypedProjection(projection);
    typedProjectionCommitted = typeof result === 'boolean'
      ? result
      : Boolean(projection.transcriptEvent);
  }

  const requiresFallback = Boolean(statusMessage) && !typedProjectionCommitted && !daemonHandledTranscriptProjection;
  if (statusMessage && requiresFallback && input.sendGenericStatusMessage) {
    const result = input.sendGenericStatusMessage(statusMessage);
    genericMessageEmitted = result === false ? false : true;
  }

  return {
    statusMessageAdded,
    genericMessageEmitted,
    typedProjectionCommitted,
    requiresFallback,
    emitted: statusMessageAdded || genericMessageEmitted || typedProjectionCommitted,
  };
}
