import { bugReportUsage } from './bugReportHelp';
export { bugReportUsage } from './bugReportHelp';
import chalk from 'chalk';
import { resolveBugReportLogSelection, type BugReportLogSelection } from '@happier-dev/protocol/bugs/reports/machineDiagnostics';

export type BugReportAttachmentArg = { path: string; sourceKind: 'attachment' | 'session-log' | 'provider-transcript' };
import type {
  BugReportDeploymentType,
  BugReportFrequency,
  BugReportSeverity,
} from '@happier-dev/protocol';
import { BUG_REPORT_DEFAULT_ISSUE_OWNER, BUG_REPORT_DEFAULT_ISSUE_REPO } from '@happier-dev/protocol/bugs/reports/types';

export type ParsedBugReportArgs = {
  sessionId: string;
  logSelection: BugReportLogSelection;
  attachments: BugReportAttachmentArg[];
  showHelp: boolean;
  title: string;
  githubUsername: string;
  summary: string;
  currentBehavior: string;
  expectedBehavior: string;
  reproductionSteps: string[];
  frequency: BugReportFrequency;
  severity: BugReportSeverity;
  whatChangedRecently: string;
  includeDiagnostics: boolean | null;
  acceptedPrivacyNotice: boolean;
  providerUrl: string;
  existingIssueNumber: number | null;
  exportPath: string;
  dryRun: boolean;
  skipSimilarIssues: boolean;
  serverVersion: string;
  deploymentType: BugReportDeploymentType | null;
};


export function parseBugReportArgs(args: string[]): ParsedBugReportArgs {
  const parsed: ParsedBugReportArgs = {
    sessionId: '',
    logSelection: resolveBugReportLogSelection(),
    attachments: [],
    showHelp: false,
    title: '',
    githubUsername: '',
    summary: '',
    currentBehavior: '',
    expectedBehavior: '',
    reproductionSteps: [],
    frequency: 'often',
    severity: 'medium',
    whatChangedRecently: '',
    includeDiagnostics: null,
    acceptedPrivacyNotice: false,
    providerUrl: '',
    existingIssueNumber: null,
    exportPath: '',
    dryRun: false,
    skipSimilarIssues: false,
    serverVersion: '',
    deploymentType: null,
  };

  const readValue = (
    index: number,
    flag: string,
    options?: { allowLeadingDash?: boolean },
  ): [string, number] => {
    const value = String(args[index + 1] ?? '');
    if (!value) {
      throw new Error(`Missing value for ${flag}`);
    }

    // Don't accidentally consume the next flag as a value.
    if (value === '-h' || value === '--help' || value.startsWith('--')) {
      throw new Error(`Missing value for ${flag}`);
    }

    const allowLeadingDash = Boolean(options?.allowLeadingDash);
    if (!allowLeadingDash && value.startsWith('-')) {
      throw new Error(`Missing value for ${flag}`);
    }

    return [value, index + 1];
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const logFlags = { '--include-daemon-logs': ['daemon', true], '--no-include-daemon-logs': ['daemon', false], '--include-session-logs': ['session', true], '--no-include-session-logs': ['session', false], '--include-provider-transcript': ['provider', true], '--no-include-provider-transcript': ['provider', false] } as const;
    if (Object.hasOwn(logFlags, arg)) {
      const [kind, enabled] = logFlags[arg as keyof typeof logFlags];
      parsed.logSelection[kind] = enabled;
      continue;
    }
    if (arg === '--session-id') { [parsed.sessionId, index] = readValue(index, arg); continue; }
    if (arg === '--attach' || arg === '--attach-session-log' || arg === '--attach-provider-transcript') {
      let path: string;
      [path, index] = readValue(index, arg);
      path = path.trim();
      if (path) parsed.attachments.push({ path, sourceKind: arg === '--attach' ? 'attachment' : arg === '--attach-session-log' ? 'session-log' : 'provider-transcript' });
      continue;
    }
    if (arg === '-h' || arg === '--help') {
      parsed.showHelp = true;
      continue;
    }
    if (arg === '--title') {
      [parsed.title, index] = readValue(index, arg, { allowLeadingDash: true });
      continue;
    }
    if (arg === '--summary') {
      [parsed.summary, index] = readValue(index, arg, { allowLeadingDash: true });
      continue;
    }
    if (arg === '--github-username') {
      [parsed.githubUsername, index] = readValue(index, arg);
      continue;
    }
    if (arg === '--current-behavior') {
      [parsed.currentBehavior, index] = readValue(index, arg, { allowLeadingDash: true });
      continue;
    }
    if (arg === '--expected-behavior') {
      [parsed.expectedBehavior, index] = readValue(index, arg, { allowLeadingDash: true });
      continue;
    }
    if (arg === '--repro-step') {
      let value = '';
      [value, index] = readValue(index, arg, { allowLeadingDash: true });
      parsed.reproductionSteps.push(value);
      continue;
    }
    if (arg === '--frequency') {
      let value = '';
      [value, index] = readValue(index, arg);
      if (value !== 'always' && value !== 'often' && value !== 'sometimes' && value !== 'once') {
        throw new Error(`Invalid --frequency value: ${value}`);
      }
      parsed.frequency = value;
      continue;
    }
    if (arg === '--severity') {
      let value = '';
      [value, index] = readValue(index, arg);
      if (value !== 'blocker' && value !== 'high' && value !== 'medium' && value !== 'low') {
        throw new Error(`Invalid --severity value: ${value}`);
      }
      parsed.severity = value;
      continue;
    }
    if (arg === '--what-changed-recently') {
      [parsed.whatChangedRecently, index] = readValue(index, arg, { allowLeadingDash: true });
      continue;
    }
    if (arg === '--include-diagnostics') {
      parsed.includeDiagnostics = true;
      continue;
    }
    if (arg === '--no-include-diagnostics') {
      parsed.includeDiagnostics = false;
      continue;
    }
    if (arg === '--accept-privacy-notice') {
      parsed.acceptedPrivacyNotice = true;
      continue;
    }
    if (arg === '--provider-url') {
      [parsed.providerUrl, index] = readValue(index, arg);
      continue;
    }
    if (arg === '--existing-issue-number') {
      let value = '';
      [value, index] = readValue(index, arg);
      const parsedNumber = Number(value);
      if (!Number.isFinite(parsedNumber) || !Number.isInteger(parsedNumber) || parsedNumber <= 0) {
        throw new Error(`Invalid --existing-issue-number value: ${value}`);
      }
      parsed.existingIssueNumber = parsedNumber;
      continue;
    }
    if (arg === '--export' || arg === '--output') {
      [parsed.exportPath, index] = readValue(index, arg);
      continue;
    }
    if (arg === '--dry-run') {
      parsed.dryRun = true;
      continue;
    }
    if (arg === '--no-similar-issues') {
      parsed.skipSimilarIssues = true;
      continue;
    }
    if (arg === '--server-version') {
      [parsed.serverVersion, index] = readValue(index, arg);
      continue;
    }
    if (arg === '--deployment-type') {
      let deployment = '';
      [deployment, index] = readValue(index, arg);
      if (deployment !== 'cloud' && deployment !== 'self-hosted' && deployment !== 'enterprise') {
        throw new Error(`Invalid --deployment-type value: ${deployment}`);
      }
      parsed.deploymentType = deployment;
      continue;
    }

    throw new Error(`Unknown argument for bug-report command: ${arg}`);
  }

  parsed.sessionId = parsed.sessionId.trim();
  parsed.title = parsed.title.trim();
  parsed.githubUsername = parsed.githubUsername.trim();
  parsed.summary = parsed.summary.trim();
  parsed.currentBehavior = parsed.currentBehavior.trim();
  parsed.expectedBehavior = parsed.expectedBehavior.trim();
  parsed.whatChangedRecently = parsed.whatChangedRecently.trim();
  parsed.providerUrl = parsed.providerUrl.trim();
  parsed.exportPath = parsed.exportPath.trim();
  if (parsed.dryRun && !parsed.exportPath) {
    throw new Error('The --dry-run option requires --output <path>');
  }
  parsed.serverVersion = parsed.serverVersion.trim();
  return parsed;
}
