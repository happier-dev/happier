import chalk from 'chalk';
import type {
  BugReportDeploymentType,
  BugReportFrequency,
  BugReportSeverity,
} from '@happier-dev/protocol';
import {
  BUG_REPORT_DEFAULT_ISSUE_LABELS,
  BUG_REPORT_DEFAULT_ISSUE_OWNER,
  BUG_REPORT_DEFAULT_ISSUE_REPO,
  normalizeBugReportIssueSlug,
} from '@happier-dev/protocol';

export type ParsedBugReportArgs = {
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
  issueOwner: string;
  issueRepo: string;
  labels: string[];
  serverVersion: string;
  deploymentType: BugReportDeploymentType | null;
};

export function bugReportUsage(): string {
  return [
    `${chalk.bold('happier bug-report')} - Submit a structured bug report with optional diagnostics`,
    '',
    `${chalk.bold('Usage:')}`,
    '  happier bug-report --title <title> --summary <text> --current-behavior <text> --expected-behavior <text> [options]',
    '',
    `${chalk.bold('Required fields:')}`,
    '  --title <text>',
    '  --summary <text>',
    '  --current-behavior <text>',
    '  --expected-behavior <text>',
    '',
    `${chalk.bold('Options:')}`,
    '  --repro-step <text>                Add one reproduction step (repeatable)',
    '  --frequency <always|often|sometimes|once>   Default: often',
    '  --severity <blocker|high|medium|low>        Default: medium',
    '  --github-username <username>        Optional reporter contact',
    '  --what-changed-recently <text>',
    '  --include-diagnostics / --no-include-diagnostics',
    '  --accept-privacy-notice            Skip interactive privacy confirmation',
    '  --provider-url <url>               Override diagnostics service URL',
    `  --issue-owner <owner>              Default: ${BUG_REPORT_DEFAULT_ISSUE_OWNER}`,
    `  --issue-repo <repo>                Default: ${BUG_REPORT_DEFAULT_ISSUE_REPO}`,
    '  --labels <comma,separated,labels>  Default: bug',
    '  --server-version <version>',
    '  --deployment-type <cloud|self-hosted|enterprise>',
    '  -h, --help',
  ].join('\n');
}

function parseCsv(raw: string): string[] {
  return String(raw ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export function parseBugReportArgs(args: string[]): ParsedBugReportArgs {
  const parsed: ParsedBugReportArgs = {
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
    issueOwner: BUG_REPORT_DEFAULT_ISSUE_OWNER,
    issueRepo: BUG_REPORT_DEFAULT_ISSUE_REPO,
    labels: [...BUG_REPORT_DEFAULT_ISSUE_LABELS],
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
    if (arg === '--issue-owner') {
      [parsed.issueOwner, index] = readValue(index, arg);
      continue;
    }
    if (arg === '--issue-repo') {
      [parsed.issueRepo, index] = readValue(index, arg);
      continue;
    }
    if (arg === '--labels') {
      let labelsRaw = '';
      [labelsRaw, index] = readValue(index, arg);
      parsed.labels = parseCsv(labelsRaw);
      if (parsed.labels.length === 0) parsed.labels = [...BUG_REPORT_DEFAULT_ISSUE_LABELS];
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

  parsed.title = parsed.title.trim();
  parsed.githubUsername = parsed.githubUsername.trim();
  parsed.summary = parsed.summary.trim();
  parsed.currentBehavior = parsed.currentBehavior.trim();
  parsed.expectedBehavior = parsed.expectedBehavior.trim();
  parsed.whatChangedRecently = parsed.whatChangedRecently.trim();
  parsed.providerUrl = parsed.providerUrl.trim();
  parsed.issueOwner = parsed.issueOwner.trim() || BUG_REPORT_DEFAULT_ISSUE_OWNER;
  parsed.issueRepo = parsed.issueRepo.trim() || BUG_REPORT_DEFAULT_ISSUE_REPO;
  const normalizedIssueOwner = normalizeBugReportIssueSlug(parsed.issueOwner);
  if (!normalizedIssueOwner) {
    throw new Error(`Invalid --issue-owner value: ${parsed.issueOwner}`);
  }
  const normalizedIssueRepo = normalizeBugReportIssueSlug(parsed.issueRepo);
  if (!normalizedIssueRepo) {
    throw new Error(`Invalid --issue-repo value: ${parsed.issueRepo}`);
  }
  parsed.issueOwner = normalizedIssueOwner;
  parsed.issueRepo = normalizedIssueRepo;
  parsed.serverVersion = parsed.serverVersion.trim();
  return parsed;
}
