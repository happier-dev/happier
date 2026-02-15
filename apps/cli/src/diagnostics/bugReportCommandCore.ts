import os from 'node:os';
import {
  BUG_REPORT_DEFAULT_ISSUE_OWNER,
  BUG_REPORT_DEFAULT_ISSUE_REPO,
  buildBugReportFallbackIssueUrl as buildFallbackIssueUrl,
  formatBugReportFallbackIssueBody as formatFallbackIssueBody,
  appendBugReportReporterToSummary,
  inferBugReportDeploymentTypeFromServerUrl as inferBugReportDeploymentType,
  normalizeBugReportProviderUrl,
  normalizeBugReportReproductionSteps as normalizeReproductionSteps,
  sanitizeBugReportUrl,
  searchBugReportSimilarIssues,
  type BugReportSimilarIssue,
  type BugReportDeploymentType,
  type BugReportEnvironmentPayload,
  type BugReportFormPayload,
} from '@happier-dev/protocol';

import packageJson from '../../package.json';
import {
  collectBugReportDiagnosticsArtifacts,
  type CollectBugReportDiagnosticsArtifactsInput as CollectDiagnosticsInput,
  type CollectBugReportDiagnosticsArtifactsResult as CollectDiagnosticsResult,
} from '@/diagnostics/bugReportArtifacts';
import { collectBugReportMachineDiagnosticsSnapshot } from '@/diagnostics/bugReportMachineDiagnostics';
import type { ServerProfile } from '@/server/serverProfiles';
import { getActiveServerProfile } from '@/server/serverProfiles';
import { isInteractiveTerminal, promptInput } from '@/cli/commands/server/commandUtilities';
import {
  bugReportUsage,
  parseBugReportArgs,
} from '@/diagnostics/bugReportCommandArgs';
import {
  fetchBugReportsFeatureFromServer,
  type BugReportsFeature,
} from '@/diagnostics/bugReportFeatureClient';
import {
  submitBugReportToService,
  type SubmitBugReportInput,
} from '@/diagnostics/bugReportSubmitFlow';

type BugReportSubmittedResult = {
  mode: 'submitted';
  reportId: string;
  issueNumber: number;
  issueUrl: string;
  diagnosticsIncluded: boolean;
  artifactCount: number;
};

type BugReportFallbackResult = {
  mode: 'fallback';
  issueUrl: string;
  diagnosticsIncluded: boolean;
};

export type BugReportCommandResult = BugReportSubmittedResult | BugReportFallbackResult;

export type BugReportCommandDependencies = {
  getActiveServerProfile: () => Promise<Pick<ServerProfile, 'id' | 'name' | 'serverUrl' | 'webappUrl'>>;
  fetchBugReportsFeature: (serverUrl: string) => Promise<BugReportsFeature>;
  collectDiagnosticsArtifacts: (input: CollectDiagnosticsInput) => Promise<CollectDiagnosticsResult>;
  submitBugReport: (input: SubmitBugReportInput) => Promise<{ reportId: string; issueNumber: number; issueUrl: string }>;
  searchSimilarIssues: (input: {
    providerUrl: string;
    owner: string;
    repo: string;
    query: string;
    limit?: number;
  }) => Promise<{ issues: BugReportSimilarIssue[] }>;
  isInteractiveTerminal: () => boolean;
  promptInput: (question: string) => Promise<string>;
};

const DEFAULT_DEPS: BugReportCommandDependencies = {
  getActiveServerProfile: async () => await getActiveServerProfile(),
  fetchBugReportsFeature: fetchBugReportsFeatureFromServer,
  collectDiagnosticsArtifacts: collectBugReportDiagnosticsArtifacts,
  submitBugReport: submitBugReportToService,
  searchSimilarIssues: async (input) =>
    await searchBugReportSimilarIssues({
      providerUrl: input.providerUrl,
      owner: input.owner,
      repo: input.repo,
      query: input.query,
      limit: input.limit,
    }),
  isInteractiveTerminal,
  promptInput,
};

async function resolveRequiredField(input: {
  value: string;
  flag: string;
  prompt: string;
  minLength?: number;
  interactive: boolean;
  promptInputFn: (question: string) => Promise<string>;
}): Promise<string> {
  const minLength = Math.max(1, Math.floor(input.minLength ?? 1));
  const initial = input.value.trim();
  if (initial.length >= minLength) return initial;
  if (!input.interactive) {
    if (initial.length > 0) {
      throw new Error(
        `Non-interactive mode: ${input.flag} is too short (min ${minLength} chars). Pass ${input.flag} "<value>"`,
      );
    }
    throw new Error(`Non-interactive mode: missing required ${input.flag}. Pass ${input.flag} "<value>"`);
  }
  // Prompt until we get a non-empty value meeting the minimum length.
  // Empty response is treated as cancellation.
  while (true) {
    const prompted = (await input.promptInputFn(input.prompt)).trim();
    if (prompted.length === 0) {
      throw new Error(`Missing required value for ${input.flag}`);
    }
    if (prompted.length >= minLength) return prompted;
  }
}

function parseYesNo(raw: string, defaultValue: boolean): boolean {
  const value = raw.trim().toLowerCase();
  if (!value) return defaultValue;
  if (value === 'y' || value === 'yes') return true;
  if (value === 'n' || value === 'no') return false;
  return defaultValue;
}

function formatSimilarIssuesPrompt(issues: BugReportSimilarIssue[]): string {
  const lines = issues.slice(0, 8).map((issue) => `- #${issue.number} (${issue.state}) ${issue.title}`);
  return [
    'Possible duplicate issues found:',
    ...lines,
    '',
    'Enter an existing issue number to comment on, or press Enter to create a new issue: ',
  ].join('\n');
}

function resolveProviderUrl(input: {
  cliOverride: string;
  featureProviderUrl: string | null;
}): string | null {
  const cliOverride = input.cliOverride.trim();
  if (cliOverride.length > 0) {
    const normalizedCli = normalizeBugReportProviderUrl(cliOverride);
    if (!normalizedCli) {
      throw new Error(`Invalid --provider-url value: ${cliOverride}`);
    }
    return normalizedCli;
  }

  return normalizeBugReportProviderUrl(input.featureProviderUrl);
}


export async function runBugReportCommand(
  args: string[],
  dependencyOverrides: Partial<BugReportCommandDependencies> = {},
): Promise<BugReportCommandResult> {
  const deps = {
    ...DEFAULT_DEPS,
    ...dependencyOverrides,
  } satisfies BugReportCommandDependencies;

  const parsed = parseBugReportArgs(args);
  if (parsed.showHelp) {
    throw new Error('Help requested');
  }
  const reproductionSteps = parsed.reproductionSteps.length > 0
    ? normalizeReproductionSteps(parsed.reproductionSteps)
    : [];

  const interactive = deps.isInteractiveTerminal();
  const activeServer = await deps.getActiveServerProfile();
  const feature = await deps.fetchBugReportsFeature(activeServer.serverUrl);
  let includeDiagnostics = parsed.includeDiagnostics ?? feature.defaultIncludeDiagnostics;

  const title = await resolveRequiredField({
    value: parsed.title,
    flag: '--title',
    prompt: 'Bug title: ',
    minLength: 3,
    interactive,
    promptInputFn: deps.promptInput,
  });
  const summary = await resolveRequiredField({
    value: parsed.summary,
    flag: '--summary',
    prompt: 'Summary: ',
    minLength: 3,
    interactive,
    promptInputFn: deps.promptInput,
  });
  const summaryWithReporter = appendBugReportReporterToSummary(summary, parsed.githubUsername);
  const currentBehavior = parsed.currentBehavior.trim() || undefined;
  const expectedBehavior = parsed.expectedBehavior.trim() || undefined;

  if (interactive && parsed.includeDiagnostics === null) {
    const defaultHint = includeDiagnostics ? 'Y/n' : 'y/N';
    const answer = await deps.promptInput(`Include diagnostics and logs? [${defaultHint}]: `);
    includeDiagnostics = parseYesNo(answer, includeDiagnostics);
  }

  let acceptedPrivacyNotice = parsed.acceptedPrivacyNotice;
  if (includeDiagnostics) {
    if (!acceptedPrivacyNotice) {
      if (!interactive) {
        throw new Error('Non-interactive mode: pass --accept-privacy-notice to confirm diagnostics privacy notice');
      }
      const answer = await deps.promptInput('Confirm privacy notice for bug report submission? [y/N]: ');
      acceptedPrivacyNotice = parseYesNo(answer, false);
    }
    if (!acceptedPrivacyNotice) {
      throw new Error('Bug report submission canceled: privacy notice must be accepted');
    }
  } else {
    // Consent applies to diagnostics; if none are included, treat as accepted for payload compatibility.
    acceptedPrivacyNotice = true;
  }

  const normalizedReproSteps = reproductionSteps.length > 0 ? reproductionSteps : undefined;

  const baseEnvironment: BugReportEnvironmentPayload = {
    appVersion: String((packageJson as { version?: string }).version ?? 'unknown'),
    platform: process.platform,
    osVersion: os.release(),
    deploymentType: parsed.deploymentType ?? inferBugReportDeploymentType(activeServer.serverUrl),
    serverUrl: sanitizeBugReportUrl(activeServer.serverUrl) ?? activeServer.serverUrl,
    serverVersion: parsed.serverVersion || undefined,
  };

  const providerUrl = resolveProviderUrl({
    cliOverride: parsed.providerUrl,
    featureProviderUrl: feature.providerUrl,
  });
  if (!feature.enabled || !providerUrl) {
    const fallbackBody = formatFallbackIssueBody({
      summary: summaryWithReporter,
      currentBehavior,
      expectedBehavior,
      reproductionSteps: normalizedReproSteps ?? [],
      frequency: parsed.frequency,
      severity: parsed.severity,
      environment: baseEnvironment,
      whatChangedRecently: parsed.whatChangedRecently || undefined,
      diagnosticsIncluded: includeDiagnostics,
    });
    return {
      mode: 'fallback',
      issueUrl: buildFallbackIssueUrl({
        owner: BUG_REPORT_DEFAULT_ISSUE_OWNER,
        repo: BUG_REPORT_DEFAULT_ISSUE_REPO,
        title,
        body: fallbackBody,
      }),
      diagnosticsIncluded: includeDiagnostics,
    };
  }

  let existingIssueNumber: number | undefined = parsed.existingIssueNumber ?? undefined;
  if (!existingIssueNumber && interactive && !parsed.skipSimilarIssues) {
    const query = [title, summary, currentBehavior ?? '', expectedBehavior ?? '']
      .map((part) => String(part).trim())
      .filter(Boolean)
      .join('\n')
      .slice(0, 1200);
    try {
        const similar = await deps.searchSimilarIssues({
          providerUrl,
          owner: BUG_REPORT_DEFAULT_ISSUE_OWNER,
          repo: BUG_REPORT_DEFAULT_ISSUE_REPO,
          query,
          limit: 8,
        });
      if (similar.issues.length > 0) {
        const answer = (await deps.promptInput(formatSimilarIssuesPrompt(similar.issues))).trim();
        if (answer) {
          const selected = Number(answer);
          if (!Number.isFinite(selected) || !Number.isInteger(selected) || selected <= 0) {
            throw new Error(`Invalid issue number: ${answer}`);
          }
          existingIssueNumber = selected;
        }
      }
    } catch {
      // If search fails, proceed without blocking bug report submission.
    }
  }

  const diagnostics = includeDiagnostics
    ? await deps.collectDiagnosticsArtifacts({
        includeDiagnostics,
        acceptedKinds: feature.acceptedArtifactKinds,
        maxArtifactBytes: feature.maxArtifactBytes,
        contextWindowMs: feature.contextWindowMs,
        serverUrl: activeServer.serverUrl,
        activeServerId: activeServer.id,
        rawArgs: args,
      })
    : { artifacts: [], environment: baseEnvironment };

  const environment: BugReportEnvironmentPayload = {
    ...diagnostics.environment,
    serverVersion: parsed.serverVersion || diagnostics.environment.serverVersion,
    deploymentType: parsed.deploymentType ?? diagnostics.environment.deploymentType,
    serverUrl: diagnostics.environment.serverUrl || activeServer.serverUrl,
  };

  const form: BugReportFormPayload = {
    title,
    summary: summaryWithReporter,
    ...(currentBehavior ? { currentBehavior } : {}),
    ...(expectedBehavior ? { expectedBehavior } : {}),
    ...(normalizedReproSteps && normalizedReproSteps.length > 0 ? { reproductionSteps: normalizedReproSteps } : {}),
    frequency: parsed.frequency,
    severity: parsed.severity,
    whatChangedRecently: parsed.whatChangedRecently || undefined,
    environment,
    consent: {
      includeDiagnostics,
      acceptedPrivacyNotice,
    },
  };

  const submitted = await deps.submitBugReport({
    providerUrl,
    timeoutMs: feature.uploadTimeoutMs,
    form,
    artifacts: diagnostics.artifacts,
    maxArtifactBytes: feature.maxArtifactBytes,
    issueOwner: BUG_REPORT_DEFAULT_ISSUE_OWNER,
    issueRepo: BUG_REPORT_DEFAULT_ISSUE_REPO,
    existingIssueNumber,
  });

  return {
    mode: 'submitted',
    reportId: submitted.reportId,
    issueNumber: submitted.issueNumber,
    issueUrl: submitted.issueUrl,
    diagnosticsIncluded: includeDiagnostics,
    artifactCount: diagnostics.artifacts.length,
  };
}

export const __internal = {
  parseBugReportArgs,
  formatFallbackIssueBody,
  buildFallbackIssueUrl,
  normalizeReproductionSteps,
  collectBugReportMachineDiagnosticsSnapshot,
};

export { bugReportUsage };
