import { logger } from '@/ui/logger';
import type { TerminalRuntimeFlags } from '@/terminal/runtime/terminalRuntimeFlags';
import { commandRegistry } from '@/cli/commandRegistry';
import { buildRootHelpText } from '@/cli/buildRootHelpText';
import { isTmuxAllowedCommand } from '@/cli/commandSurfaceManifest';
import { readStartedByArg } from '@/cli/readStartedByArg';
import { AGENTS, requireCatalogEntry } from '@/backends/catalog';
import { DEFAULT_CATALOG_AGENT_ID } from '@/backends/types';
import { readCredentials } from '@/persistence';
import { readProfileQueryFromArgs, resolveProfileRoutedAgentIdFromSettings } from '@/cli/profileDefaultAgentRouting';
import { resolveInheritedHerdrRuntime } from '@/terminal/runtime/inheritedHerdrRuntime';
import { applyDaemonAutostartEnvForInvocation, shouldEnsureDaemonForInvocation } from '@/daemon/ensureDaemon';
import { applyEphemeralServerSelectionFromPrefixArgs } from '@/server/serverSelection';
import packageJson from '../../package.json';
import { fail } from '@happier-dev/cli-common/output';
import { argvBeforeOptionTerminator } from '@/cli/commands/shared/argvFlags';

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
    console.error(fail(error instanceof Error ? error.message : String(error)));
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
  const optionArgs = argvBeforeOptionTerminator(args);
  if (optionArgs.includes('--tmux')) {
    // If user is asking for help/version, don't start a session.
    if (optionArgs.includes('-h') || optionArgs.includes('--help') || optionArgs.includes('-v') || optionArgs.includes('--version')) {
      const idx = args.indexOf('--tmux');
      if (idx !== -1) args.splice(idx, 1);
    } else {
      if (subcommand && !isTmuxAllowedCommand(subcommand)) {
        console.error(fail('--tmux can only be used when starting a session.'));
        process.exit(1);
        return;
      }

      try {
        const { startHappyHeadlessInTmux } = await import('@/terminal/tmux/startHappyHeadlessInTmux');
        await startHappyHeadlessInTmux(args);
      } catch (error) {
        console.error(fail(error instanceof Error ? error.message : 'Unknown error'));
        if (process.env.DEBUG) {
          console.error(error);
        }
        process.exit(1);
      }
      return;
    }
  }
  const commandHandler = (subcommand ? commandRegistry[subcommand] : undefined);
  if (commandHandler) {
    const startsSession = subcommand === 'resume'
      || Object.values(AGENTS).some((entry) => entry?.cliSubcommand === subcommand);
    await commandHandler({
      args,
      rawArgv,
      terminalRuntime: startsSession
        ? await resolveInheritedHerdrRuntime({ terminalRuntime, env: process.env })
        : terminalRuntime,
    });
    return;
  }

  const defaultEntry = requireCatalogEntry(DEFAULT_CATALOG_AGENT_ID);

  // Bare `happier --profile <query>` starts the profile's default agent when it has one;
  // without a routable default the default-backend handler below reports the profile error.
  const profileQuery = readProfileQueryFromArgs(args);
  if (profileQuery) {
    const credentials = await readCredentials();
    const routedAgentId = await resolveProfileRoutedAgentIdFromSettings({ profileQuery, credentials });
    if (routedAgentId && routedAgentId !== DEFAULT_CATALOG_AGENT_ID && AGENTS[routedAgentId as keyof typeof AGENTS]?.getCliCommandHandler) {
      const routedHandler = await AGENTS[routedAgentId as keyof typeof AGENTS]!.getCliCommandHandler!();
      await routedHandler({
        args,
        rawArgv,
        terminalRuntime: await resolveInheritedHerdrRuntime({ terminalRuntime, env: process.env }),
      });
      return;
    }
  }

  if (!defaultEntry.getCliCommandHandler) {
    throw new Error(`Default agent '${DEFAULT_CATALOG_AGENT_ID}' has no CLI command handler registered`);
  }
  const defaultHandler = await defaultEntry.getCliCommandHandler();
  await defaultHandler({
    args,
    rawArgv,
    terminalRuntime: await resolveInheritedHerdrRuntime({ terminalRuntime, env: process.env }),
  });
}
