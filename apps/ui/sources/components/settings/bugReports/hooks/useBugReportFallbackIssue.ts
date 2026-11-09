import * as React from 'react';

import type { BugReportDeploymentType, BugReportFrequency, BugReportSeverity } from '../bugReportFallback';
import { openBugReportFallbackFromDraft } from '../bugReportFallbackSubmission';
import { useClipboardWrite } from '@/hooks/ui/useClipboardWrite';

export function useBugReportFallbackIssue(input: Readonly<{
  route: string;
  title: string;
  reporterGithubUsername: string;
  summary: string;
  currentBehavior: string;
  expectedBehavior: string;
  reproductionStepsText: string;
  whatChangedRecently: string;
  frequency: BugReportFrequency;
  severity: BugReportSeverity;
  includeDiagnostics: boolean;
}>): (environment: {
  appVersion: string;
  platform: string;
  osVersion?: string;
  deviceModel?: string;
  serverUrl?: string;
  serverVersion?: string;
  deploymentType: BugReportDeploymentType;
}) => Promise<void> {
  const writeClipboard = useClipboardWrite();
  return React.useCallback(async (environment) => {
    await openBugReportFallbackFromDraft({ ...input, environment, acceptedPrivacyNotice: false }, writeClipboard, input.route);
  }, [
    input.currentBehavior,
    input.expectedBehavior,
    input.frequency,
    input.includeDiagnostics,
    input.reporterGithubUsername,
    input.reproductionStepsText,
    input.route,
    input.severity,
    input.summary,
    input.title,
    input.whatChangedRecently,
    writeClipboard,
  ]);
}
