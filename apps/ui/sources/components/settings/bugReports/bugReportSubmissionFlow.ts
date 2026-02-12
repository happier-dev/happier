import { appendBugReportReporterToSummary, type BugReportFormPayload } from '@happier-dev/protocol';

import type { Machine } from '@/sync/domains/state/storageTypes';

import { normalizeReproductionSteps, type BugReportDeploymentType, type BugReportFrequency, type BugReportSeverity } from './bugReportFallback';
import type { BugReportsFeature } from './bugReportFeatureDefaults';
import type { BugReportDiagnosticsArtifact } from './bugReportDiagnostics';

export type BugReportComposerSubmissionInput = {
    title: string;
    summary: string;
    reporterGithubUsername?: string;
    currentBehavior: string;
    expectedBehavior: string;
    reproductionStepsText: string;
    whatChangedRecently: string;
    frequency: BugReportFrequency;
    severity: BugReportSeverity;
    environment: {
        appVersion: string;
        platform: string;
        osVersion?: string;
        deviceModel?: string;
        serverUrl?: string;
        serverVersion?: string;
        deploymentType: BugReportDeploymentType;
    };
    includeDiagnostics: boolean;
    diagnosticsKinds?: string[];
    acceptedPrivacyNotice: boolean;
};

export type BugReportDraftValidation =
    | { code: 'ok' }
    | { code: 'title'; title: string; message: string }
    | { code: 'details'; title: string; message: string }
    | { code: 'privacy'; title: string; message: string };

export type BugReportSubmissionOutcome =
    | { mode: 'fallback' }
    | {
        mode: 'submitted';
        reportId: string;
        issueNumber: number;
        issueUrl: string;
        artifactCount: number;
    };

function toOptionalValue(raw: string | undefined): string | undefined {
    const value = String(raw ?? '').trim();
    return value.length > 0 ? value : undefined;
}

function buildBugReportForm(input: BugReportComposerSubmissionInput): BugReportFormPayload {
    const acceptedPrivacyNotice = input.includeDiagnostics ? input.acceptedPrivacyNotice : true;
    return {
        title: input.title.trim(),
        summary: appendBugReportReporterToSummary(input.summary, input.reporterGithubUsername),
        currentBehavior: input.currentBehavior.trim(),
        expectedBehavior: input.expectedBehavior.trim(),
        reproductionSteps: normalizeReproductionSteps(input.reproductionStepsText),
        frequency: input.frequency,
        severity: input.severity,
        whatChangedRecently: toOptionalValue(input.whatChangedRecently),
        environment: {
            ...input.environment,
            appVersion: input.environment.appVersion.trim() || 'unknown',
            platform: input.environment.platform.trim() || 'unknown',
            osVersion: toOptionalValue(input.environment.osVersion),
            deviceModel: toOptionalValue(input.environment.deviceModel),
            serverUrl: toOptionalValue(input.environment.serverUrl),
            serverVersion: toOptionalValue(input.environment.serverVersion),
        },
        consent: {
            includeDiagnostics: input.includeDiagnostics,
            allowMaintainerFollowUp: true,
            acceptedPrivacyNotice,
        },
    };
}

export function validateBugReportDraft(input: BugReportComposerSubmissionInput): BugReportDraftValidation {
    if (input.title.trim().length < 3) {
        return {
            code: 'title',
            title: 'Missing title',
            message: 'Please add a short bug title (at least 3 characters).',
        };
    }
    if (
        input.summary.trim().length < 5
        || input.currentBehavior.trim().length < 5
        || input.expectedBehavior.trim().length < 5
    ) {
        return {
            code: 'details',
            title: 'Incomplete report',
            message: 'Please fill summary, current behavior, and expected behavior.',
        };
    }
    if (input.includeDiagnostics && !input.acceptedPrivacyNotice) {
        return {
            code: 'privacy',
            title: 'Privacy consent required',
            message: 'Please confirm that diagnostics may include non-sensitive debugging data.',
        };
    }
    return { code: 'ok' };
}

export async function submitBugReportFromDraft(input: {
    feature: BugReportsFeature;
    machines: Machine[];
    input: BugReportComposerSubmissionInput;
    issueOwner: string;
    issueRepo: string;
    labels: string[];
    openFallbackIssue: (environment: BugReportComposerSubmissionInput['environment']) => Promise<void>;
    collectDiagnosticsArtifacts: (input: {
        machines: Machine[];
        includeDiagnostics: boolean;
        acceptedKinds: string[];
        maxArtifactBytes: number;
        contextWindowMs?: number;
    }) => Promise<{ artifacts: BugReportDiagnosticsArtifact[] }>;
    submitBugReport: (input: {
        providerUrl: string;
        timeoutMs: number;
        form: BugReportFormPayload;
        artifacts: BugReportDiagnosticsArtifact[];
        maxArtifactBytes?: number;
        issueOwner: string;
        issueRepo: string;
        labels?: string[];
    }) => Promise<{ reportId: string; issueNumber: number; issueUrl: string }>;
}): Promise<BugReportSubmissionOutcome> {
    if (!input.feature.enabled || !input.feature.providerUrl) {
        await input.openFallbackIssue(input.input.environment);
        return { mode: 'fallback' };
    }

    const overrideKinds = Array.isArray(input.input.diagnosticsKinds) ? input.input.diagnosticsKinds : null;
    const acceptedKinds = overrideKinds
        ? overrideKinds.filter((kind) => input.feature.acceptedArtifactKinds.includes(kind))
        : input.feature.acceptedArtifactKinds;
    const includeDiagnostics = input.input.includeDiagnostics && acceptedKinds.length > 0;
    const diagnostics = includeDiagnostics
        ? await input.collectDiagnosticsArtifacts({
            machines: input.machines,
            includeDiagnostics,
            acceptedKinds,
            maxArtifactBytes: input.feature.maxArtifactBytes,
            contextWindowMs: input.feature.contextWindowMs,
        })
        : { artifacts: [] };

    const submitted = await input.submitBugReport({
        providerUrl: input.feature.providerUrl,
        timeoutMs: input.feature.uploadTimeoutMs,
        form: buildBugReportForm({ ...input.input, includeDiagnostics }),
        artifacts: diagnostics.artifacts,
        maxArtifactBytes: input.feature.maxArtifactBytes,
        issueOwner: input.issueOwner,
        issueRepo: input.issueRepo,
        labels: input.labels,
    });

    return {
        mode: 'submitted',
        reportId: submitted.reportId,
        issueNumber: submitted.issueNumber,
        issueUrl: submitted.issueUrl,
        artifactCount: diagnostics.artifacts.length,
    };
}
