import { detectClientCommandOs } from '@/components/machines/add/machineAddCommand';
import { Platform } from 'react-native';

import type { BugReportDeploymentType, BugReportFrequency, BugReportSeverity } from './bugReportFallback';
import type { BugReportComposerSubmissionInput } from './bugReportSubmissionFlow';

export const BUG_REPORT_CURRENT_BEHAVIOR_MAX_LENGTH = 5000;

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

/**
 * The OS line of a report. Native platforms report a real version; React Native Web reports a
 * placeholder ("0.0.0"), so on web the OS is named from the browser through the existing detector,
 * and left empty when it cannot be told.
 */
export function resolveBugReportOsVersion(input: Readonly<{ os: string; version: string | number | null | undefined; userAgent: string | null }>): string {
    if (input.os !== 'web') return input.version == null ? '' : String(input.version);
    const os = detectClientCommandOs(input.userAgent);
    return os === 'macos' ? 'macOS' : os === 'windows' ? 'Windows' : os === 'linux' ? 'Linux' : '';
}
