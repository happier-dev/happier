import { logger } from '@/ui/logger';
import type { TerminalRuntimeFlags } from '@/terminal/runtime/terminalRuntimeFlags';
import { commandRegistry } from '@/cli/commandRegistry';
import { buildRootHelpText } from '@/cli/buildRootHelpText';
import { isTmuxAllowedCommand } from '@/cli/commandSurfaceManifest';
import { AGENTS, requireCatalogEntry } from '@/backends/catalog';
import { DEFAULT_CATALOG_AGENT_ID } from '@/backends/types';
import { partitionProviderSessionArgs } from '@/cli/providerSessionArgPartition';
import type { CommandContext } from '@/cli/commandRegistry';
import { prepareProfileSessionStart } from '@/cli/profileDefaultAgentRouting';
import { resolveInheritedHerdrRuntime } from '@/terminal/runtime/inheritedHerdrRuntime';
import { applyDaemonAutostartEnvForInvocation } from '@/daemon/ensureDaemon';
import { applyEphemeralServerSelectionFromPrefixArgs } from '@/server/serverSelection';
import packageJson from '../../package.json';
import { fail } from '@happier-dev/cli-common/output';
import { argvBeforeOptionTerminator } from '@/cli/commands/shared/argvFlags';

function applySessionInvocationEnvironment(command: string | undefined, args: string[]): void {
  const entry = Object.values(AGENTS).find((candidate) => candidate?.cliSubcommand === command);
  applyDaemonAutostartEnvForInvocation({
    args,
    env: process.env,
    autostartInInteractiveTerminal: entry?.autostartDaemonInInteractiveTerminal,
  });
}

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
        // Implicit profile selection belongs to the child session invocation; do
        // not turn its fallback into an explicit inherited daemon preference.
        if (subcommand && commandRegistry[subcommand]) applySessionInvocationEnvironment(subcommand, args);
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
  let command = subcommand;
  let sessionStart: CommandContext['sessionStart'];
  if (!commandRegistry[command ?? '']) {
    const parsed = partitionProviderSessionArgs({ args });
    if (parsed.profileQuery && !parsed.helpRequested && !parsed.versionRequested) {
      const prepared = await prepareProfileSessionStart({
        profileQuery: parsed.profileQuery,
        startedBy: parsed.startedBy,
        refreshRequested: parsed.refreshSettings,
      });
      sessionStart = prepared.sessionStart;
      const target = prepared.backendTarget;
      if (target?.kind === 'configuredAcpBackend') {
        command = 'acp-catalog';
        args = ['acp-catalog', '--backend', target.backendId, ...args];
      } else if (target?.kind === 'builtInAgent') {
        command = requireCatalogEntry(target.agentId).cliSubcommand;
      }
    }
  }
  applySessionInvocationEnvironment(command, args);
  const commandHandler = command ? commandRegistry[command] : undefined;
  if (commandHandler) {
    const startsSession = command === 'resume' || command === 'acp-catalog'
      || Object.values(AGENTS).some((entry) => entry?.cliSubcommand === command);
    await commandHandler({
      args,
      rawArgv,
      ...(sessionStart ? { sessionStart } : {}),
      terminalRuntime: startsSession
        ? await resolveInheritedHerdrRuntime({ terminalRuntime, env: process.env })
        : terminalRuntime,
    });
    return;
  }

  const defaultEntry = requireCatalogEntry(DEFAULT_CATALOG_AGENT_ID);
  if (!defaultEntry.getCliCommandHandler) {
    throw new Error(`Default agent '${DEFAULT_CATALOG_AGENT_ID}' has no CLI command handler registered`);
  }
  const defaultHandler = await defaultEntry.getCliCommandHandler();
  await defaultHandler({
    args,
    rawArgv,
    ...(sessionStart ? { sessionStart } : {}),
    terminalRuntime: await resolveInheritedHerdrRuntime({ terminalRuntime, env: process.env }),
  });
}
