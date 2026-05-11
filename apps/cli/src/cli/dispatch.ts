import chalk from 'chalk';
import { logger } from '@/ui/logger';
import type { TerminalRuntimeFlags } from '@/terminal/runtime/terminalRuntimeFlags';
import { commandRegistry } from '@/cli/commandRegistry';
import { buildRootHelpText } from '@/cli/buildRootHelpText';
import { isTmuxAllowedCommand } from '@/cli/commandSurfaceManifest';
import { readStartedByArg } from '@/cli/readStartedByArg';
import { requireCatalogEntry } from '@/backends/catalog';
import { DEFAULT_CATALOG_AGENT_ID } from '@/backends/types';
import { applyDaemonAutostartEnvForInvocation, shouldEnsureDaemonForInvocation } from '@/daemon/ensureDaemon';
import { applyEphemeralServerSelectionFromPrefixArgs } from '@/server/serverSelection';
import packageJson from '../../package.json';

export async function dispatchCli(params: Readonly<{
  args: string[];
  terminalRuntime: TerminalRuntimeFlags | null;
  rawArgv: string[];
}>): Promise<void> {
  let args = [...params.args];
  const { terminalRuntime, rawArgv } = params;

  // Handle top-level version requests before backend resolution/auth flows.
  if (args.length === 1 && (args[0] === '--version' || args[0] === '-v')) {
    console.log(packageJson.version);
    return;
  }
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    console.log(buildRootHelpText());
    return;
  }

  // If --version is passed - do not log, its likely daemon inquiring about our version
  if (!args.includes('--version')) {
    logger.debug('Starting happy CLI with args: ', rawArgv);
  }

  try {
    args = await applyEphemeralServerSelectionFromPrefixArgs(args);
  } catch (error) {
    console.error(chalk.red('Error:'), error instanceof Error ? error.message : String(error));
    process.exit(1);
    return;
  }

  // Check if first argument is a subcommand
  const subcommand = args[0];

  // Codex should prefer local TUI when invoked directly in a real terminal.
  // The daemon always forces `--started-by daemon`, so this only affects direct `happier codex` usage.
  if (subcommand === 'codex') {
    const current = (process.env.HAPPIER_SESSION_AUTOSTART_DAEMON ?? '').toString().trim();
    const startedBy = readStartedByArg(args);
    const startedByDaemon = startedBy.value === 'daemon';
    const shouldLeaveDefaults = startedBy.present && startedBy.value === null;
    if (!current && !startedByDaemon && !shouldLeaveDefaults && process.stdin.isTTY && process.stdout.isTTY) {
      process.env.HAPPIER_SESSION_AUTOSTART_DAEMON = '0';
    }
  }

  applyDaemonAutostartEnvForInvocation({ args, env: process.env });

  // Headless tmux launcher (CLI flow)
  if (args.includes('--tmux')) {
    // If user is asking for help/version, don't start a session.
    if (args.includes('-h') || args.includes('--help') || args.includes('-v') || args.includes('--version')) {
      const idx = args.indexOf('--tmux');
      if (idx !== -1) args.splice(idx, 1);
    } else {
      if (subcommand && !isTmuxAllowedCommand(subcommand)) {
        console.error(chalk.red('Error:'), '--tmux can only be used when starting a session.');
        process.exit(1);
        return;
      }

      try {
        const { startHappyHeadlessInTmux } = await import('@/terminal/tmux/startHappyHeadlessInTmux');
        await startHappyHeadlessInTmux(args);
      } catch (error) {
        console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
        if (process.env.DEBUG) {
          console.error(error)
        }
        process.exit(1)
      }
      return;
    }
  }
  const commandHandler = (subcommand ? commandRegistry[subcommand] : undefined);
  if (commandHandler) {
    await commandHandler({ args, rawArgv, terminalRuntime });
    return;
  }

  const defaultEntry = requireCatalogEntry(DEFAULT_CATALOG_AGENT_ID);
  if (!defaultEntry.getCliCommandHandler) {
    throw new Error(`Default agent '${DEFAULT_CATALOG_AGENT_ID}' has no CLI command handler registered`);
  }
  const defaultHandler = await defaultEntry.getCliCommandHandler();
  await defaultHandler({ args, rawArgv, terminalRuntime });
}
