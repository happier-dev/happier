import os from 'node:os';
import {
  buildBugReportFallbackIssueUrl as buildFallbackIssueUrl,
  formatBugReportFallbackIssueBody as formatFallbackIssueBody,
  appendBugReportReporterToSummary,
  inferBugReportDeploymentTypeFromServerUrl as inferBugReportDeploymentType,
  normalizeBugReportProviderUrl,
  normalizeBugReportReproductionSteps as normalizeReproductionSteps,
  sanitizeBugReportUrl,
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
  isInteractiveTerminal: () => boolean;
  promptInput: (question: string) => Promise<string>;
};

const DEFAULT_DEPS: BugReportCommandDependencies = {
  getActiveServerProfile: async () => await getActiveServerProfile(),
  fetchBugReportsFeature: fetchBugReportsFeatureFromServer,
  collectDiagnosticsArtifacts: collectBugReportDiagnosticsArtifacts,
  submitBugReport: submitBugReportToService,
  isInteractiveTerminal,
  promptInput,
};

async function resolveRequiredField(input: {
  value: string;
  flag: string;
  prompt: string;
  interactive: boolean;
  promptInputFn: (question: string) => Promise<string>;
}): Promise<string> {
  const initial = input.value.trim();
  if (initial.length > 0) return initial;
  if (!input.interactive) {
    throw new Error(`Non-interactive mode: missing required ${input.flag}. Pass ${input.flag} "<value>"`);
  }
  const prompted = (await input.promptInputFn(input.prompt)).trim();
  if (prompted.length > 0) return prompted;
  throw new Error(`Missing required value for ${input.flag}`);
}

function parseYesNo(raw: string, defaultValue: boolean): boolean {
  const value = raw.trim().toLowerCase();
  if (!value) return defaultValue;
  if (value === 'y' || value === 'yes') return true;
  if (value === 'n' || value === 'no') return false;
  return defaultValue;
}

function resolveProviderUrl(input: {
  cliOverride: string;
  envOverride: string | undefined;
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

  const envOverride = String(input.envOverride ?? '').trim();
  if (envOverride.length > 0) {
    const normalizedEnv = normalizeBugReportProviderUrl(envOverride);
    if (normalizedEnv) {
      return normalizedEnv;
    }
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
  const reproductionSteps = normalizeReproductionSteps(parsed.reproductionSteps);

  const interactive = deps.isInteractiveTerminal();
  const activeServer = await deps.getActiveServerProfile();
  const feature = await deps.fetchBugReportsFeature(activeServer.serverUrl);
  const includeDiagnostics = parsed.includeDiagnostics ?? feature.defaultIncludeDiagnostics;

  const title = await resolveRequiredField({
    value: parsed.title,
    flag: '--title',
    prompt: 'Bug title: ',
    interactive,
    promptInputFn: deps.promptInput,
  });
  const summary = await resolveRequiredField({
    value: parsed.summary,
    flag: '--summary',
    prompt: 'Summary: ',
    interactive,
    promptInputFn: deps.promptInput,
  });
  const summaryWithReporter = appendBugReportReporterToSummary(summary, parsed.githubUsername);
  const currentBehavior = await resolveRequiredField({
    value: parsed.currentBehavior,
    flag: '--current-behavior',
    prompt: 'Current behavior: ',
    interactive,
    promptInputFn: deps.promptInput,
  });
  const expectedBehavior = await resolveRequiredField({
    value: parsed.expectedBehavior,
    flag: '--expected-behavior',
    prompt: 'Expected behavior: ',
    interactive,
    promptInputFn: deps.promptInput,
  });

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
    envOverride: process.env.HAPPIER_BUG_REPORTS_PROVIDER_URL,
    featureProviderUrl: feature.providerUrl,
  });
  if (!feature.enabled || !providerUrl) {
    const fallbackBody = formatFallbackIssueBody({
      summary: summaryWithReporter,
      currentBehavior,
      expectedBehavior,
      reproductionSteps,
      frequency: parsed.frequency,
      severity: parsed.severity,
      environment: baseEnvironment,
      whatChangedRecently: parsed.whatChangedRecently || undefined,
      diagnosticsIncluded: includeDiagnostics,
    });
    return {
      mode: 'fallback',
      issueUrl: buildFallbackIssueUrl({
        owner: parsed.issueOwner,
        repo: parsed.issueRepo,
        title,
        body: fallbackBody,
        labels: parsed.labels,
      }),
      diagnosticsIncluded: includeDiagnostics,
    };
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
    currentBehavior,
    expectedBehavior,
    reproductionSteps,
    frequency: parsed.frequency,
    severity: parsed.severity,
    whatChangedRecently: parsed.whatChangedRecently || undefined,
    environment,
    consent: {
      includeDiagnostics,
      allowMaintainerFollowUp: true,
      acceptedPrivacyNotice,
    },
  };

  const submitted = await deps.submitBugReport({
    providerUrl,
    timeoutMs: feature.uploadTimeoutMs,
    form,
    artifacts: diagnostics.artifacts,
    maxArtifactBytes: feature.maxArtifactBytes,
    issueOwner: parsed.issueOwner,
    issueRepo: parsed.issueRepo,
    labels: parsed.labels,
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
