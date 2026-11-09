import chalk from 'chalk';

export function bugReportUsage(): string {
  return [
    `${chalk.bold('happier bug-report')} - Submit a structured bug report with optional diagnostics`,
    '',
    `${chalk.bold('Usage:')}`,
    '  happier bug-report --title <title> --summary <text> [options]',
    '',
    `${chalk.bold('Required fields:')}`,
    '  --title <text>',
    '  --summary <text>',
    '',
    `${chalk.bold('Options:')}`,
    '  --current-behavior <text>         Optional extra detail',
    '  --expected-behavior <text>        Optional extra detail',
    '  --repro-step <text>                Add one reproduction step (repeatable)',
    '  --frequency <always|often|sometimes|once>   Default: often',
    '  --severity <blocker|high|medium|low>        Default: medium',
    '  --github-username <username>        Optional reporter contact',
    '  --what-changed-recently <text>',
    '  --include-diagnostics / --no-include-diagnostics',
    '  --accept-privacy-notice            Skip interactive privacy confirmation',
    '  --provider-url <url>               Override diagnostics service URL',
    '  --export <path>                    Write a redacted diagnostics bundle without submitting',
    '  --dry-run --output <path>          Collect and export diagnostics without submitting',
    '  --existing-issue-number <number>   Post report as a comment on an existing issue',
    '  --no-similar-issues                Skip searching for similar issues',
    '  --server-version <version>',
    '  --deployment-type <cloud|self-hosted|enterprise>',
    '  --session-id <id>                  Select the exact Happier session for diagnostics',
    '  --include-daemon-logs / --no-include-daemon-logs       Default: included',
    '  --include-session-logs / --no-include-session-logs     Default: included',
    '  --include-provider-transcript / --no-include-provider-transcript   Default: excluded',
    '  --attach <path> / --attach-session-log <path> / --attach-provider-transcript <path> (repeatable)',
    '  -h, --help',
  ].join('\n');
}

