export type BugReportFrequency = 'always' | 'often' | 'sometimes' | 'once';
export type BugReportSeverity = 'blocker' | 'high' | 'medium' | 'low';
export type BugReportDeploymentType = 'cloud' | 'self-hosted' | 'enterprise';

export type BugReportEnvironmentPayload = {
  appVersion: string;
  platform: string;
  deploymentType: BugReportDeploymentType;
  osVersion?: string;
  deviceModel?: string;
  serverUrl?: string;
  serverVersion?: string;
};

export type BugReportFormPayload = {
  title: string;
  summary: string;
  currentBehavior: string;
  expectedBehavior: string;
  reproductionSteps: string[];
  frequency: BugReportFrequency;
  severity: BugReportSeverity;
  whatChangedRecently?: string;
  environment: BugReportEnvironmentPayload;
  consent: {
    includeDiagnostics: boolean;
    allowMaintainerFollowUp?: boolean;
    acceptedPrivacyNotice: boolean;
  };
};

export type BugReportArtifactPayload = {
  filename: string;
  sourceKind: string;
  contentType: string;
  content: string;
};

export type BugReportServiceSubmitInput = {
  providerUrl: string;
  timeoutMs: number;
  form: BugReportFormPayload;
  artifacts: BugReportArtifactPayload[];
  maxArtifactBytes?: number;
  issueOwner: string;
  issueRepo: string;
  labels?: string[];
  clientPrefix?: string;
  existingIssueNumber?: number;
};

export const BUG_REPORT_DEFAULT_ISSUE_OWNER = 'happier-dev';
export const BUG_REPORT_DEFAULT_ISSUE_REPO = 'happier';
export const BUG_REPORT_DEFAULT_ISSUE_LABELS: readonly string[] = ['bug'];
export const BUG_REPORT_FALLBACK_MAX_LABELS = 10;
export const BUG_REPORT_FALLBACK_MAX_LABEL_LENGTH = 40;
export const BUG_REPORT_FALLBACK_ISSUE_URL_MAX_LENGTH = 7600;
export const BUG_REPORT_FALLBACK_BODY_TRUNCATION_SUFFIX = '\n\n[bug report content truncated due to URL length limits]';
