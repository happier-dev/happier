import chalk from 'chalk';

export const WATCH_PR_COMMAND_USAGE = 'happier automation watch-pr --session <id> --workflow <ref> --on <ciFailed|prComment> --once --by <ISO-date-time> [--json]';

export function showAutomationHelp(): void {
  console.log(`
${chalk.bold('happier automation')} - Manage automations

${chalk.bold('Usage:')}
  happier automation list [--cursor <opaque>] [--json]
  happier automation run <automation-id> [--idempotency-key <key>] [--json]
  ${WATCH_PR_COMMAND_USAGE}

${chalk.bold('Commands:')}
  list   List automations with their stable IDs
  run    Queue an immediate run through the automation's existing assignments
  watch-pr  Run once for the Session's linked PR event or the deadline, whichever arrives first

${chalk.bold('Options:')}
  --cursor <opaque>        Continue listing from an opaque cursor
  --idempotency-key <key>  Reuse the same run when a trigger occurrence is retried
  --json                   Print a machine-readable result
`);
}

