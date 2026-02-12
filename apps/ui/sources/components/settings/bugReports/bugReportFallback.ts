import {
    buildBugReportFallbackIssueUrl,
    formatBugReportFallbackIssueBody,
    normalizeBugReportReproductionSteps,
    type BugReportDeploymentType,
    type BugReportEnvironmentPayload,
    type BugReportFrequency,
    type BugReportSeverity,
} from '@happier-dev/protocol';

export type {
    BugReportDeploymentType,
    BugReportFrequency,
    BugReportSeverity,
};

export type FallbackIssueEnvironment = BugReportEnvironmentPayload;

export type FallbackIssueBodyInput = {
    summary: string;
    currentBehavior: string;
    expectedBehavior: string;
    reproductionSteps: string[];
    frequency: BugReportFrequency;
    severity: BugReportSeverity;
    environment: FallbackIssueEnvironment;
    whatChangedRecently?: string;
    diagnosticsIncluded: boolean;
};

export function normalizeReproductionSteps(raw: string): string[] {
    return normalizeBugReportReproductionSteps(raw);
}

export function formatFallbackIssueBody(input: FallbackIssueBodyInput): string {
    return formatBugReportFallbackIssueBody(input);
}

export function buildFallbackIssueUrl(input: {
    title: string;
    body: string;
    owner: string;
    repo: string;
    labels?: string[];
}): string {
    return buildBugReportFallbackIssueUrl(input);
}
