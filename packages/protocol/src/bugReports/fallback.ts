import {
  BUG_REPORT_DEFAULT_ISSUE_LABELS,
  BUG_REPORT_DEFAULT_ISSUE_OWNER,
  BUG_REPORT_DEFAULT_ISSUE_REPO,
  BUG_REPORT_FALLBACK_BODY_TRUNCATION_SUFFIX,
  BUG_REPORT_FALLBACK_ISSUE_URL_MAX_LENGTH,
  BUG_REPORT_FALLBACK_MAX_LABEL_LENGTH,
  BUG_REPORT_FALLBACK_MAX_LABELS,
  type BugReportEnvironmentPayload,
  type BugReportFrequency,
  type BugReportSeverity,
} from './types.js';
import { resolveBugReportIssueTargetWithDefaults } from './issueTarget.js';
import { sanitizeBugReportUrl } from './sanitize.js';

export function normalizeBugReportReproductionSteps(raw: string | string[]): string[] {
  const inputLines = Array.isArray(raw)
    ? raw.flatMap((value) => String(value ?? '').split(/\r?\n/))
    : String(raw ?? '').split(/\r?\n/);
  const steps = inputLines
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.replace(/^((\d+[.)])|[-*•])\s*/, '').trim())
    .filter((line) => line.length > 0);
  if (steps.length === 0) return ['Unknown'];
  return steps.slice(0, 20);
}

export function formatBugReportFallbackIssueBody(input: {
  summary: string;
  currentBehavior: string;
  expectedBehavior: string;
  reproductionSteps: string[];
  frequency: BugReportFrequency;
  severity: BugReportSeverity;
  environment: BugReportEnvironmentPayload;
  whatChangedRecently?: string;
  diagnosticsIncluded: boolean;
}): string {
  const steps = input.reproductionSteps.map((step, index) => `${index + 1}. ${step}`).join('\n');
  const sanitizedServerUrl = sanitizeBugReportUrl(input.environment.serverUrl);

  return [
    '## Summary',
    input.summary,
    '',
    '## Current Behavior',
    input.currentBehavior,
    '',
    '## Expected Behavior',
    input.expectedBehavior,
    '',
    '## Reproduction Steps',
    steps,
    '',
    '## Frequency / Severity',
    `- Frequency: ${input.frequency}`,
    `- Severity: ${input.severity}`,
    '',
    '## Environment',
    `- App version: ${input.environment.appVersion}`,
    `- Platform: ${input.environment.platform}`,
    input.environment.osVersion ? `- OS: ${input.environment.osVersion}` : null,
    input.environment.deviceModel ? `- Device: ${input.environment.deviceModel}` : null,
    input.environment.serverVersion ? `- Server version: ${input.environment.serverVersion}` : null,
    sanitizedServerUrl ? `- Server URL: ${sanitizedServerUrl}` : null,
    `- Deployment: ${input.environment.deploymentType}`,
    '',
    '## Diagnostics',
    `- Diagnostics: ${input.diagnosticsIncluded ? 'included' : 'not included'}`,
    '- Diagnostics artifacts are unavailable from this fallback flow.',
    '',
    input.whatChangedRecently?.trim() ? '## What changed recently' : null,
    input.whatChangedRecently?.trim() ? input.whatChangedRecently.trim() : null,
  ].filter((line): line is string => Boolean(line)).join('\n');
}

export function buildBugReportFallbackIssueUrl(input: {
  title: string;
  body: string;
  owner: string;
  repo: string;
  labels?: string[];
}): string {
  const issueTarget = resolveBugReportIssueTargetWithDefaults({
    owner: input.owner,
    repo: input.repo,
    defaultOwner: BUG_REPORT_DEFAULT_ISSUE_OWNER,
    defaultRepo: BUG_REPORT_DEFAULT_ISSUE_REPO,
  });
  const labels = Array.from(
    new Set(
      (input.labels ?? BUG_REPORT_DEFAULT_ISSUE_LABELS)
        .map((label) => String(label ?? '').trim())
        .filter((label) => label.length > 0)
        .map((label) => label.slice(0, BUG_REPORT_FALLBACK_MAX_LABEL_LENGTH)),
    ),
  ).slice(0, BUG_REPORT_FALLBACK_MAX_LABELS);
  const normalizedLabels = labels.length > 0 ? labels : BUG_REPORT_DEFAULT_ISSUE_LABELS;
  const issuePath = `https://github.com/${issueTarget.owner}/${issueTarget.repo}/issues/new`;
  const encode = (value: string) => encodeURIComponent(value).replace(/%20/g, '%20');
  const normalizedTitle = (input.title.trim() || 'Bug report').slice(0, 200);

  const buildUrlWithBody = (body: string): string => {
    const query = [
      `title=${encode(normalizedTitle)}`,
      `body=${encode(body)}`,
      `labels=${encode(normalizedLabels.join(','))}`,
    ].join('&');
    return `${issuePath}?${query}`;
  };

  const initialUrl = buildUrlWithBody(input.body);
  if (initialUrl.length <= BUG_REPORT_FALLBACK_ISSUE_URL_MAX_LENGTH) return initialUrl;

  const suffix = BUG_REPORT_FALLBACK_BODY_TRUNCATION_SUFFIX;
  const body = String(input.body ?? '');
  let low = 0;
  let high = body.length;
  let bestBody = suffix;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const nextBody = `${body.slice(0, mid)}${suffix}`;
    const nextUrl = buildUrlWithBody(nextBody);
    if (nextUrl.length <= BUG_REPORT_FALLBACK_ISSUE_URL_MAX_LENGTH) {
      bestBody = nextBody;
      low = mid + 1;
      continue;
    }
    high = mid - 1;
  }

  return buildUrlWithBody(bestBody);
}
