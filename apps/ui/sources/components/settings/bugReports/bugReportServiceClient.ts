import {
    submitBugReportToService as submitBugReportToSharedService,
    searchBugReportSimilarIssues as searchBugReportSimilarIssuesShared,
    type BugReportSimilarIssue,
    type BugReportArtifactPayload,
    type BugReportFormPayload,
} from '@happier-dev/protocol';
import { captureBugReportSentryEvent } from '@/utils/system/sentry';

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
    const sentryEvent = await captureBugReportSentryEvent();
    const artifacts = sentryEvent
        ? input.artifacts.concat([
              {
                  filename: 'sentry-event.json',
                  sourceKind: 'ui',
                  contentType: 'application/json',
                  content: JSON.stringify(sentryEvent, null, 2),
              },
          ])
        : input.artifacts;

    return await submitBugReportToSharedService({
        ...input,
        artifacts,
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
