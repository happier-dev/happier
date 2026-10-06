import { submitBugReportToService as submitBugReportToSharedService } from '@happier-dev/protocol/bugs/reports/submit';
import type { BugReportArtifactPayload, BugReportFormPayload } from '@happier-dev/protocol';

export type SubmitBugReportInput = {
  providerUrl: string;
  timeoutMs: number;
  form: BugReportFormPayload;
  artifacts: BugReportArtifactPayload[];
  maxArtifactBytes?: number;
  issueOwner: string;
  issueRepo: string;
  existingIssueNumber?: number;
};

export async function submitBugReportToService(input: SubmitBugReportInput): Promise<{
  reportId: string;
  issueNumber: number;
  issueUrl: string;
}> {
  return await submitBugReportToSharedService({
    ...input,
    clientPrefix: 'cli',
  });
}
