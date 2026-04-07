import {
  submitBugReportToService as submitBugReportToSharedService,
  type BugReportFormPayload,
} from '@happier-dev/protocol';

import { collectSupportBugReportArtifacts } from './collectSupportBugReportArtifacts.js';
import type { SupportReport } from '../types.js';

export type SubmitSupportReportInput = Readonly<{
  providerUrl: string;
  timeoutMs: number;
  form: BugReportFormPayload;
  report: SupportReport;
  maxArtifactBytes: number;
  acceptedKinds: readonly string[];
  issueOwner: string;
  issueRepo: string;
  existingIssueNumber?: number;
}>;

export async function submitSupportReport(
  input: SubmitSupportReportInput,
  deps: Readonly<{
    submitBugReportToService?: typeof submitBugReportToSharedService;
  }> = {},
): Promise<{
  reportId: string;
  issueNumber: number;
  issueUrl: string;
}> {
  const submitBugReportToService = deps.submitBugReportToService ?? submitBugReportToSharedService;
  return await submitBugReportToService({
    providerUrl: input.providerUrl,
    timeoutMs: input.timeoutMs,
    form: input.form,
    artifacts: collectSupportBugReportArtifacts(input.report, {
      acceptedKinds: input.acceptedKinds,
      maxArtifactBytes: input.maxArtifactBytes,
    }),
    maxArtifactBytes: input.maxArtifactBytes,
    issueOwner: input.issueOwner,
    issueRepo: input.issueRepo,
    existingIssueNumber: input.existingIssueNumber,
    clientPrefix: 'support',
  });
}
