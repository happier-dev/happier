import * as React from 'react';

import {
  BUG_REPORT_DEFAULT_ISSUE_OWNER,
  BUG_REPORT_DEFAULT_ISSUE_REPO,
  appendBugReportReporterToSummary,
} from '@happier-dev/protocol';

import { clearBugReportUserActionTrail, recordBugReportUserAction } from '@/utils/system/bugReportActionTrail';
import { clearBugReportLogBuffer } from '@/utils/system/bugReportLogBuffer';

import {
  buildFallbackIssueUrl,
  formatFallbackIssueBody,
  normalizeReproductionSteps,
  type BugReportDeploymentType,
  type BugReportFrequency,
  type BugReportSeverity,
} from '../bugReportFallback';
import { openBugReportFallbackIssueUrl } from '../openBugReportFallback';

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
  return React.useCallback(async (environment) => {
    const fallbackBody = formatFallbackIssueBody({
      summary: appendBugReportReporterToSummary(input.summary, input.reporterGithubUsername),
      currentBehavior: input.currentBehavior.trim(),
      expectedBehavior: input.expectedBehavior.trim(),
      reproductionSteps: normalizeReproductionSteps(input.reproductionStepsText),
      frequency: input.frequency,
      severity: input.severity,
      environment,
      whatChangedRecently: input.whatChangedRecently.trim() || undefined,
      diagnosticsIncluded: input.includeDiagnostics,
    });

    const url = buildFallbackIssueUrl({
      owner: BUG_REPORT_DEFAULT_ISSUE_OWNER,
      repo: BUG_REPORT_DEFAULT_ISSUE_REPO,
      title: input.title.trim() || 'Bug report',
      body: fallbackBody,
    });

    const opened = await openBugReportFallbackIssueUrl(url);
    if (opened) {
      recordBugReportUserAction('bug-report.fallback-opened', {
        route: input.route,
        metadata: { diagnosticsIncluded: input.includeDiagnostics },
      });
      clearBugReportUserActionTrail();
      clearBugReportLogBuffer();
    }
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
  ]);
}

