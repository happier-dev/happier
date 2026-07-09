import type { ConnectedServiceRuntimeFailureClassification } from '../types';
import type { ConnectedServiceRuntimeAuthFailureDaemonReport } from '../reportConnectedServiceRuntimeAuthFailureToDaemon';
import type { ConnectedServiceRuntimeAuthRecoveryProjection } from './connectedServiceRuntimeAuthRecoveryProjection';
import type { Metadata } from '@/api/types';
import { buildRuntimeAuthUsageLimitRecoveryMetadataUpdater } from './connectedServiceRuntimeAuthRecoveryUsageLimitMetadata';

export type ConnectedServiceRuntimeAuthRecoveryProjectionResult = Readonly<{
  statusMessageAdded: boolean;
  genericMessageEmitted: boolean;
  typedProjectionCommitted: boolean;
  usageLimitMetadataCommitted: boolean;
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

export function connectedServiceRuntimeAuthRecoveryCanOwnTurnFailure(recoveryReport: unknown): boolean {
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
  addStatusMessage?: (message: string) => void;
  sendGenericStatusMessage?: (message: string) => void;
  commitTypedProjection?: (projection: ConnectedServiceRuntimeAuthRecoveryProjection) => boolean | void;
  commitUsageLimitRecoveryMetadata?: (updater: (metadata: Metadata) => Metadata) => boolean | void;
}>): ConnectedServiceRuntimeAuthRecoveryProjectionResult {
  const statusMessage = input.report.statusMessage;
  const projection = input.report.projection;
  let statusMessageAdded = false;
  let genericMessageEmitted = false;
  let typedProjectionCommitted = false;
  let usageLimitMetadataCommitted = false;

  if (statusMessage) {
    input.addStatusMessage?.(statusMessage);
    statusMessageAdded = Boolean(input.addStatusMessage);
  }

  const hasDaemonTranscriptEvent = Boolean(projection?.transcriptEvent);
  const hasProviderTypedProjection = Boolean(projection?.uxDiagnostic) && !hasDaemonTranscriptEvent;
  if (projection && hasProviderTypedProjection && input.commitTypedProjection) {
    typedProjectionCommitted = input.commitTypedProjection(projection) !== false;
  }

  const usageLimitMetadataUpdater = input.classification
    ? buildRuntimeAuthUsageLimitRecoveryMetadataUpdater({
      report: input.report,
      classification: input.classification,
    })
    : null;
  if (usageLimitMetadataUpdater && input.commitUsageLimitRecoveryMetadata) {
    const result = input.commitUsageLimitRecoveryMetadata(usageLimitMetadataUpdater);
    usageLimitMetadataCommitted = result === false ? false : true;
  }

  const requiresFallback = Boolean(statusMessage) && !typedProjectionCommitted && !hasDaemonTranscriptEvent;
  if (statusMessage && requiresFallback && input.sendGenericStatusMessage) {
    input.sendGenericStatusMessage(statusMessage);
    genericMessageEmitted = true;
  }

  return {
    statusMessageAdded,
    genericMessageEmitted,
    typedProjectionCommitted,
    usageLimitMetadataCommitted,
    requiresFallback,
    emitted: statusMessageAdded || genericMessageEmitted || typedProjectionCommitted || usageLimitMetadataCommitted,
  };
}
