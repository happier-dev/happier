import type { VoiceDiagnosticsConsentCopy } from './voiceDiagnosticsConsentTranslations.shared';



export type VoiceDiagnosticsCopy = Readonly<{
  title: string;
  footer: string;
  enabled: string;
  enabledSubtitle: string;
  sttInput: string;
  ttsOutput: string;
  location: string;
  unavailable: string;
  retention: string;
  retentionDetail: (args: { hours: number; files: number; megabytes: number }) => string;
  deleteAll: string;
  deleteAllSubtitle: string;
  deleteConfirmTitle: string;
  deleteConfirmBody: string;
  deleteAction: string;
  deleteFailed: string;
  cleanupRequired: string;
  cleanupRequiredSubtitle: string;
  captureFailed: string;
  captureFailedSubtitle: string;
  retryCleanup: string;
  retryCleanupSubtitle: string;
  cleanupRetryFailed: string;
  exportTitle: string;
  noArtifacts: string;
  exportSttArtifact: string;
  exportTtsArtifact: string;
  exportArtifactAccessibility: string;
  exportConfirmTitle: string;
  exportConfirmBody: string;
  exportAction: string;
  exportFailed: string;
  backupPolicy: string;
  backupPolicyBestEffort: string;
  activeIndicator: string;
  checkingIndicator: string;
  statusUnknownIndicator: string;
  shutdownPendingIndicator: string;
  shutdownFailedIndicator: string;
  retryShutdown: string;
  sessionOptOut: string;
  sessionOptOutConfirmTitle: string;
  sessionOptOutConfirmBody: string;
  sessionOptOutFailed: string;
  sessionOptOutRetry: string;
}>;



export function defineVoiceDiagnostics(consent: VoiceDiagnosticsConsentCopy, copy: VoiceDiagnosticsCopy) {
  return { diagnostics: { ...consent, ...copy } };
}
