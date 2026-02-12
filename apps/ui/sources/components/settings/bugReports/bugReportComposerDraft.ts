import { Platform } from 'react-native';

import type { BugReportDeploymentType, BugReportFrequency, BugReportSeverity } from './bugReportFallback';
import type { BugReportComposerSubmissionInput } from './bugReportSubmissionFlow';

function toOptionalValue(raw: string): string | undefined {
    const value = raw.trim();
    return value.length > 0 ? value : undefined;
}

export function buildBugReportComposerDraftInput(input: {
    title: string;
    reporterGithubUsername: string;
    summary: string;
    currentBehavior: string;
    expectedBehavior: string;
    reproductionStepsText: string;
    whatChangedRecently: string;
    frequency: BugReportFrequency;
    severity: BugReportSeverity;
    appVersion: string;
    platformValue: string;
    osVersion: string;
    deviceModel: string;
    serverUrl: string;
    serverVersion: string;
    deploymentType: BugReportDeploymentType;
    includeDiagnostics: boolean;
    diagnosticsKinds?: string[];
    acceptedPrivacyNotice: boolean;
}): BugReportComposerSubmissionInput {
    return {
        title: input.title,
        reporterGithubUsername: input.reporterGithubUsername,
        summary: input.summary,
        currentBehavior: input.currentBehavior,
        expectedBehavior: input.expectedBehavior,
        reproductionStepsText: input.reproductionStepsText,
        whatChangedRecently: input.whatChangedRecently,
        frequency: input.frequency,
        severity: input.severity,
        environment: {
            appVersion: input.appVersion.trim() || 'unknown',
            platform: input.platformValue.trim() || Platform.OS,
            osVersion: toOptionalValue(input.osVersion),
            deviceModel: toOptionalValue(input.deviceModel),
            serverUrl: toOptionalValue(input.serverUrl),
            serverVersion: toOptionalValue(input.serverVersion),
            deploymentType: input.deploymentType,
        },
        includeDiagnostics: input.includeDiagnostics,
        diagnosticsKinds: Array.isArray(input.diagnosticsKinds) ? input.diagnosticsKinds : undefined,
        acceptedPrivacyNotice: input.acceptedPrivacyNotice,
    };
}
