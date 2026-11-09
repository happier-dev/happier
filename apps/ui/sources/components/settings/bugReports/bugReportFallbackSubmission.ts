import { BUG_REPORT_DEFAULT_ISSUE_OWNER, BUG_REPORT_DEFAULT_ISSUE_REPO } from '@happier-dev/protocol/bugs/reports/types';
import { appendBugReportReporterToSummary } from '@happier-dev/protocol/bugs/reports/reporter';
import { buildBugReportFallbackIssueUrl, formatBugReportFallbackIssueBody, normalizeBugReportReproductionSteps } from '@happier-dev/protocol/bugs/reports/fallback';
import { clearBugReportUserActionTrail, recordBugReportUserAction } from '@/utils/system/bugReportActionTrail';
import { clearBugReportLogBuffer } from '@/utils/system/bugReportLogBuffer';
import { openBugReportFallbackIssueUrl } from './openBugReportFallback';
import type { BugReportComposerSubmissionInput } from './bugReportSubmissionFlow';

/** The existing manual issue fallback, shared by Submit and its failure continuation. */
export async function openBugReportFallbackFromDraft(input: BugReportComposerSubmissionInput,
  copyUrl: (value: string) => Promise<boolean>, route?: string): Promise<void> {
  const body = formatBugReportFallbackIssueBody({ ...input,
    summary: appendBugReportReporterToSummary(input.summary, input.reporterGithubUsername),
    reproductionSteps: normalizeBugReportReproductionSteps(input.reproductionStepsText),
    diagnosticsIncluded: input.includeDiagnostics,
  });
  const opened = await openBugReportFallbackIssueUrl(buildBugReportFallbackIssueUrl({
    owner: BUG_REPORT_DEFAULT_ISSUE_OWNER, repo: BUG_REPORT_DEFAULT_ISSUE_REPO,
    title: input.title.trim() || 'Bug report', body,
  }), { copyUrl });
  if (opened) {
    recordBugReportUserAction('bug-report.fallback-opened', { route, metadata: { diagnosticsIncluded: input.includeDiagnostics } });
    clearBugReportUserActionTrail();
    clearBugReportLogBuffer();
  }
}
