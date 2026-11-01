import { submitBugReportToService as submitBugReportToSharedService } from '@happier-dev/protocol/bugs/reports/submit';
import { searchBugReportSimilarIssues as searchBugReportSimilarIssuesShared, type BugReportSimilarIssue } from '@happier-dev/protocol/bugs/reports/similarIssues';
import type { BugReportArtifactPayload, BugReportFormPayload } from '@happier-dev/protocol/bugs/reports/types';

export type {
    BugReportArtifactPayload,
    BugReportEnvironmentPayload,
    BugReportFormPayload,
} from '@happier-dev/protocol';

export type { BugReportSimilarIssue } from '@happier-dev/protocol';

export async function submitBugReportToService(input: {
    providerUrl: string;
    timeoutMs: number;
    form: BugReportFormPayload;
    artifacts: BugReportArtifactPayload[];
    maxArtifactBytes?: number;
    issueOwner: string;
    issueRepo: string;
    existingIssueNumber?: number;
}): Promise<{ reportId: string; issueNumber: number; issueUrl: string }> {
    return await submitBugReportToSharedService({
        ...input,
        clientPrefix: 'ui',
    });
}

export async function searchBugReportSimilarIssues(input: {
    providerUrl: string;
    owner: string;
    repo: string;
    query: string;
    limit?: number;
}): Promise<{ issues: BugReportSimilarIssue[] }> {
    return await searchBugReportSimilarIssuesShared({
        providerUrl: input.providerUrl,
        owner: input.owner,
        repo: input.repo,
        query: input.query,
        limit: input.limit,
    });
}
