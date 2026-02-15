import React from 'react';

import {
  BUG_REPORT_DEFAULT_ISSUE_OWNER,
  BUG_REPORT_DEFAULT_ISSUE_REPO,
} from '@happier-dev/protocol';

import type { Machine } from '@/sync/domains/state/storageTypes';
import type { Profile } from '@/sync/domains/profiles/profile';

import { collectBugReportDiagnosticsArtifacts } from '../bugReportDiagnostics';
import type { BugReportsFeature } from '../bugReportFeatureDefaults';
import type {
  BugReportDeploymentType,
  BugReportFrequency,
  BugReportSeverity,
} from '../bugReportFallback';

import { useBugReportDiagnosticsPreview } from './useBugReportDiagnosticsPreview';
import { useBugReportDiagnosticsSelection } from './useBugReportDiagnosticsSelection';
import { useBugReportComposerDraftState } from './useBugReportComposerDraftState';
import { useBugReportComposerSubmit } from './useBugReportComposerSubmit';
import { useBugReportFallbackIssue } from './useBugReportFallbackIssue';
import { useBugReportSimilarIssues } from './useBugReportSimilarIssues';
import { getBugReportDraftFieldErrors, validateBugReportDraft, type BugReportDraftFieldErrors, type BugReportDraftValidation } from '../bugReportSubmissionFlow';

export function useBugReportComposerModel(input: Readonly<{
  feature: BugReportsFeature;
  machines: Machine[];
  profile: Profile | null;
  serverUrlDefault: string;
  route: string;
}>): {
  title: string;
  setTitle: (value: string) => void;
  reporterGithubUsername: string;
  setReporterGithubUsername: (value: string) => void;
  summary: string;
  setSummary: (value: string) => void;
  currentBehavior: string;
  setCurrentBehavior: (value: string) => void;
  expectedBehavior: string;
  setExpectedBehavior: (value: string) => void;
  reproductionStepsText: string;
  setReproductionStepsText: (value: string) => void;
  whatChangedRecently: string;
  setWhatChangedRecently: (value: string) => void;
  frequency: BugReportFrequency;
  setFrequency: (value: BugReportFrequency) => void;
  severity: BugReportSeverity;
  setSeverity: (value: BugReportSeverity) => void;
  deploymentType: BugReportDeploymentType;
  setDeploymentType: (value: BugReportDeploymentType) => void;
  appVersion: string;
  setAppVersion: (value: string) => void;
  platformValue: string;
  setPlatformValue: (value: string) => void;
  osVersion: string;
  setOsVersion: (value: string) => void;
  deviceModel: string;
  setDeviceModel: (value: string) => void;
  serverUrl: string;
  setServerUrl: (value: string) => void;
  serverVersion: string;
  setServerVersion: (value: string) => void;
  includeDiagnostics: boolean;
  setIncludeDiagnostics: (value: boolean) => void;
  diagnosticsKinds: string[];
  setDiagnosticsKinds: (value: string[]) => void;
  acceptedPrivacyNotice: boolean;
  setAcceptedPrivacyNotice: (value: boolean) => void;
  submitting: boolean;
  existingIssueNumber: number | null;
  setExistingIssueNumber: (value: number | null) => void;
  previewingDiagnostics: boolean;
  previewDisabled: boolean;
  handlePreviewDiagnostics: () => Promise<void>;
  similarIssues: ReturnType<typeof useBugReportSimilarIssues>;
  validation: BugReportDraftValidation;
  fieldErrors: BugReportDraftFieldErrors;
  handleSubmit: () => Promise<void>;
} {
  const draft = useBugReportComposerDraftState({
    profile: input.profile,
    serverUrlDefault: input.serverUrlDefault,
  });
  const { buildDraftInput, ...draftFields } = draft;

  const {
    includeDiagnostics,
    setIncludeDiagnostics,
    diagnosticsKinds,
    setDiagnosticsKinds,
  } = useBugReportDiagnosticsSelection(input.feature);

  const [existingIssueNumber, setExistingIssueNumber] = React.useState<number | null>(null);

  const openFallbackIssue = useBugReportFallbackIssue({
    route: input.route,
    title: draftFields.title,
    reporterGithubUsername: draftFields.reporterGithubUsername,
    summary: draftFields.summary,
    currentBehavior: draftFields.currentBehavior,
    expectedBehavior: draftFields.expectedBehavior,
    reproductionStepsText: draftFields.reproductionStepsText,
    whatChangedRecently: draftFields.whatChangedRecently,
    frequency: draftFields.frequency,
    severity: draftFields.severity,
    includeDiagnostics,
  });

  const collectDiagnosticsForPreview = React.useCallback(async () => {
    return await collectBugReportDiagnosticsArtifacts({
      machines: input.machines,
      includeDiagnostics,
      acceptedKinds: diagnosticsKinds,
      maxArtifactBytes: input.feature.maxArtifactBytes,
      contextWindowMs: input.feature.contextWindowMs,
    });
  }, [diagnosticsKinds, includeDiagnostics, input.feature.contextWindowMs, input.feature.maxArtifactBytes, input.machines]);

  const { submitting, handleSubmit } = useBugReportComposerSubmit({
    feature: input.feature,
    machines: input.machines,
    route: input.route,
    includeDiagnostics,
    diagnosticsKinds,
    issueOwner: BUG_REPORT_DEFAULT_ISSUE_OWNER,
    issueRepo: BUG_REPORT_DEFAULT_ISSUE_REPO,
    existingIssueNumber,
    openFallbackIssue,
    buildDraftInput,
  });

  const draftInput = React.useMemo(
    () => buildDraftInput({ includeDiagnostics, diagnosticsKinds }),
    [buildDraftInput, diagnosticsKinds, includeDiagnostics],
  );
  const validation = React.useMemo(() => validateBugReportDraft(draftInput), [draftInput]);
  const fieldErrors = React.useMemo(() => getBugReportDraftFieldErrors(draftInput), [draftInput]);

  const diagnosticsPreview = useBugReportDiagnosticsPreview({
    disabled: submitting,
    includeDiagnostics,
    selectedKinds: diagnosticsKinds,
    collectDiagnosticsArtifacts: collectDiagnosticsForPreview,
  });

  const similarIssues = useBugReportSimilarIssues({
    enabled: input.feature.enabled,
    providerUrl: input.feature.providerUrl,
    owner: BUG_REPORT_DEFAULT_ISSUE_OWNER,
    repo: BUG_REPORT_DEFAULT_ISSUE_REPO,
    title: draftFields.title,
    summary: draftFields.summary,
    currentBehavior: draftFields.currentBehavior,
    expectedBehavior: draftFields.expectedBehavior,
    disabled: submitting || existingIssueNumber !== null,
  });

  return {
    ...draftFields,
    includeDiagnostics,
    setIncludeDiagnostics,
    diagnosticsKinds,
    setDiagnosticsKinds,
    submitting,
    existingIssueNumber,
    setExistingIssueNumber,
    previewingDiagnostics: diagnosticsPreview.previewing,
    previewDisabled: diagnosticsPreview.previewDisabled,
    handlePreviewDiagnostics: diagnosticsPreview.handlePreview,
    similarIssues,
    validation,
    fieldErrors,
    handleSubmit,
  };
}
