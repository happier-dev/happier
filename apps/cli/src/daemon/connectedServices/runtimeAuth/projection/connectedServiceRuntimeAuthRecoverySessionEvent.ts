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
  const daemonHandledTranscriptProjection = Boolean(input.report.handled && hasDaemonTranscriptEvent);
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
  if (usageLimitMetadataUpdater && input.commitUsageLimitRecoveryMetadata && !daemonHandledTranscriptProjection) {
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
