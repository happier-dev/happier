import chalk from 'chalk';
import type { CommandContext } from '@/cli/commandRegistry';
import {
  __internal,
  bugReportUsage,
  runBugReportCommand,
  type BugReportCommandDependencies,
  type BugReportCommandResult,
} from '@/diagnostics/bugReportCommandCore';

async function handleBugReportCommand(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(bugReportUsage());
    return;
  }

  const result = await runBugReportCommand(args);
  if (result.mode === 'fallback') {
    console.log(chalk.yellow('Bug report service is unavailable for this server. Open this fallback issue URL:'));
    console.log(result.issueUrl);
    return;
  }

  console.log(chalk.green('✓ Bug report submitted'));
  console.log(chalk.gray(`  Issue: ${result.issueUrl}`));
  console.log(chalk.gray(`  Report ID: ${result.reportId}`));
  console.log(chalk.gray(`  Diagnostics included: ${result.diagnosticsIncluded ? 'yes' : 'no'}`));
  console.log(chalk.gray(`  Uploaded artifacts: ${result.artifactCount}`));
}

export async function handleBugReportCliCommand(context: CommandContext): Promise<void> {
  try {
    await handleBugReportCommand(context.args.slice(1));
  } catch (error) {
    if (error instanceof Error && error.message === 'Help requested') {
      console.log(bugReportUsage());
      return;
    }
    console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error');
    if (process.env.DEBUG) {
      console.error(error);
    }
    process.exit(1);
  }
}
export { __internal, runBugReportCommand };
export type { BugReportCommandDependencies, BugReportCommandResult };
