import {
    submitBugReportToService as submitBugReportToSharedService,
    type BugReportArtifactPayload,
    type BugReportFormPayload,
} from '@happier-dev/protocol';

export type {
    BugReportArtifactPayload,
    BugReportEnvironmentPayload,
    BugReportFormPayload,
} from '@happier-dev/protocol';

export async function submitBugReportToService(input: {
    providerUrl: string;
    timeoutMs: number;
    form: BugReportFormPayload;
    artifacts: BugReportArtifactPayload[];
    maxArtifactBytes?: number;
    issueOwner: string;
    issueRepo: string;
    labels?: string[];
}): Promise<{ reportId: string; issueNumber: number; issueUrl: string }> {
    return await submitBugReportToSharedService({
        ...input,
        clientPrefix: 'ui',
    });
}
