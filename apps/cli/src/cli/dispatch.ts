import type { TerminalRuntimeFlags } from '@/terminal/runtime/terminalRuntimeFlags';
import {
  commandRegistry,
  ensureMergedAgentCommandRegistryLoaded,
  findCommandDispatchDescriptor,
  resolvePluginCommandTmuxMode,
  type CommandContext,
} from '@/cli/commandRegistry';
import { buildRootHelpText } from '@/cli/buildRootHelpText';
import {
  findCommandSurfaceEntry,
  isStaticCommandSurfaceProviderPlaceholder,
  isTmuxAllowedCommand,
} from '@/cli/commandSurfaceManifest';
import { readStartedByArg } from '@/cli/readStartedByArg';
import { applyDaemonAutostartEnvForInvocation, shouldEnsureDaemonForInvocation } from '@/daemon/daemonAutostartPolicy';
import { printJsonEnvelope, wantsJson } from '@/cli/output/jsonEnvelope';
import { errorFrame } from '@happier-dev/cli-common/output';
import packageJson from '../../package.json';
import { resolveExplicitSpawnScopedEnvironmentFromProcessEnv } from '@/daemon/spawn/spawnExplicitEnvKeysMarker';
import {
  redactCliApiTokenArgv,
  takeCliApiTokenEnvironment,
  takePrefixCliApiTokenFlag,
  validateCliApiTokenEnvironment,
  withCliApiToken,
} from '@/auth/cliApiToken';

function isTopLevelVersionRequest(args: readonly string[]): boolean {
  return args.length === 1 && (args[0] === '--version' || args[0] === '-v');
}

function isTopLevelHelpRequest(args: readonly string[]): boolean {
  return args.length === 1 && (args[0] === '--help' || args[0] === '-h');
}

function applyCommandDaemonAutostartDefaultPolicy(params: Readonly<{
  args: readonly string[];
  env: NodeJS.ProcessEnv;
  policy: NonNullable<ReturnType<typeof findCommandDispatchDescriptor>>['policy'] | undefined;
}>): void {
  if (params.policy?.daemonAutostartDefault !== 'preferLocalTui') return;
  const current = (params.env.HAPPIER_SESSION_AUTOSTART_DAEMON ?? '').toString().trim();
  if (current) return;

  const startedBy = readStartedByArg(params.args);
  if (startedBy.value === 'daemon') return;
  if (startedBy.present && startedBy.value === null) return;
  if (!process.stdin.isTTY || !process.stdout.isTTY) return;

  params.env.HAPPIER_SESSION_AUTOSTART_DAEMON = '0';
}

function resolveUnknownCommandSuggestion(command: string): string | null {
  const candidates = command.endsWith('s')
    ? [command.slice(0, -1)]
    : [`${command}s`];

  for (const candidate of candidates) {
    if (!candidate || candidate === command) continue;
    if (findCommandDispatchDescriptor(candidate) || findCommandSurfaceEntry(candidate)) {
      return candidate;
    }
  }

  return null;
}

function buildUnknownCommandMessage(command: string, suggestedCommand: string | null): string {
  return suggestedCommand
    ? `Unknown command: ${command}. Did you mean \`happier ${suggestedCommand}\`?`
    : `Unknown command: ${command}.`;
}

function hasEphemeralServerSelectionPrefixArgs(args: readonly string[]): boolean {
  for (const arg of args) {
    if (
      arg === '--server'
      || arg.startsWith('--server=')
      || arg === '--server-url'
      || arg.startsWith('--server-url=')
      || arg === '--webapp-url'
      || arg.startsWith('--webapp-url=')
      || arg === '--local-server-url'
      || arg.startsWith('--local-server-url=')
      || arg === '--public-server-url'
      || arg.startsWith('--public-server-url=')
    ) {
      return true;
    }
    if (!arg.startsWith('--')) return false;
  }
  return false;
}

function debugCliStart(rawArgv: readonly string[]): void {
  if (!process.env.DEBUG) return;
  void import('@/ui/logger')
    .then(({ logger }) => {
      logger.debug('Starting happy CLI with args: ', rawArgv);
    })
    .catch(() => undefined);
}

async function failClosedReservedRootCommand(args: readonly string[], command: string): Promise<boolean> {
  if (!findCommandSurfaceEntry(command)) return false;

  const suggestedCommand = resolveUnknownCommandSuggestion(command);
  const message = buildUnknownCommandMessage(command, suggestedCommand);
  if (wantsJson(args)) {
    await printJsonEnvelope(
      {
        ok: false,
        kind: 'cli_dispatch',
        error: {
          code: 'unknown_command',
          command,
          message,
          ...(suggestedCommand ? { suggestedCommand } : {}),
        },
      },
      { exitCode: 1 },
    );
    return true;
  }

  console.error(errorFrame('Error:', [message]));
  process.exitCode = 1;
  return true;
}

async function rejectTmuxInvocation(args: readonly string[], message: string): Promise<void> {
  if (wantsJson(args)) {
    await printJsonEnvelope(
      {
        ok: false,
        kind: 'cli_dispatch',
        error: {
          code: 'tmux_not_allowed',
          message,
        },
      },
      { exitCode: 1 },
    );
    return;
  }
  console.error(errorFrame('Error:', [message]));
  process.exit(1);
}

async function reportInvalidGlobalArguments(args: readonly string[], error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  if (wantsJson(args)) {
    await printJsonEnvelope(
      {
        ok: false,
        kind: 'cli_dispatch',
        error: {
          code: 'invalid_arguments',
          message,
        },
      },
      { exitCode: 1 },
    );
    return;
  }
  console.error(errorFrame('Error:', [message]));
  process.exit(1);
}

async function applyGlobalInvocationOptions(
  argsRaw: readonly string[],
  ambientApiToken: ReturnType<typeof takeCliApiTokenEnvironment>,
): Promise<Readonly<{
  args: string[];
  apiToken: string | null;
}>> {
  let args = [...argsRaw];
  let apiToken: string | null = null;

  while (true) {
    const tokenFlag = takePrefixCliApiTokenFlag(args);
    if (tokenFlag) {
      if (apiToken !== null) {
        throw new Error('--api-token may be supplied only once.');
      }
      apiToken = tokenFlag.token;
      args = tokenFlag.rest;
      continue;
    }

    if (!hasEphemeralServerSelectionPrefixArgs(args)) break;
    const { applyEphemeralServerSelectionFromPrefixArgs } = await import('@/server/serverSelection');
    const selectedArgs = await applyEphemeralServerSelectionFromPrefixArgs(args);
    if (selectedArgs.length === args.length) break;
    args = selectedArgs;
  }

  // Validate the env form at the same CLI boundary when it remains the selected
  // credential. A valid explicit flag deliberately wins over an irrelevant env value.
  if (apiToken === null && ambientApiToken !== null) {
    apiToken = validateCliApiTokenEnvironment(ambientApiToken);
  }

  return { args, apiToken };
}

async function launchCommandInTmux(
  args: string[],
  command: string | undefined,
): Promise<void> {
  const json = wantsJson(args);
  try {
    const { startHappyHeadlessInTmux } = await import('@/integrations/tmux/startHeadlessSession');
    await startHappyHeadlessInTmux(args, json ? { output: 'silent' } : undefined);
    if (json) {
      await printJsonEnvelope({
        ok: true,
        kind: 'cli_dispatch',
        data: {
          command: command ?? null,
          launched: 'tmux',
        },
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    if (json) {
      await printJsonEnvelope(
        {
          ok: false,
          kind: 'cli_dispatch',
          error: {
            code: 'tmux_launch_failed',
            message,
          },
        },
        { exitCode: 1 },
      );
      return;
    }
    console.error(errorFrame('Error:', [message]));
    if (process.env.DEBUG) {
      console.error(error);
    }
    process.exit(1);
  }
}

export async function dispatchCli(params: Readonly<{
  args: string[];
  terminalRuntime: TerminalRuntimeFlags | null;
  rawArgv: string[];
  signal?: AbortSignal;
  /** @internal Root global options have been consumed for this dispatch. */
  globalOptionsApplied?: boolean;
}>): Promise<void> {
  if (!params.globalOptionsApplied) {
    // Consume these process-wide input variables before any command can create
    // a generic child. The selected value continues only in invocation-local
    // memory; a tmux re-exec receives the dedicated one-shot handoff instead.
    const ambientApiToken = takeCliApiTokenEnvironment();
    let globalOptions: Awaited<ReturnType<typeof applyGlobalInvocationOptions>>;
    try {
      globalOptions = await applyGlobalInvocationOptions(params.args, ambientApiToken);
    } catch (error) {
      await reportInvalidGlobalArguments(params.args, error);
      return;
    }

    const dispatchWithGlobalOptions = async () => await dispatchCli({
      ...params,
      args: globalOptions.args,
      rawArgv: redactCliApiTokenArgv(params.rawArgv),
      globalOptionsApplied: true,
    });
    if (globalOptions.apiToken !== null) {
      await withCliApiToken(globalOptions.apiToken, dispatchWithGlobalOptions);
      return;
    }
    await dispatchWithGlobalOptions();
    return;
  }

  let args = [...params.args];
  const { terminalRuntime, rawArgv } = params;
  let signal = params.signal;
  const scopedEnvironment =
    resolveExplicitSpawnScopedEnvironmentFromProcessEnv(process.env);
  const buildCommandContext = (contextArgs: string[]): CommandContext => ({
    args: contextArgs,
    rawArgv,
    terminalRuntime,
    ...(signal ? { signal } : {}),
    ...(scopedEnvironment ? { scopedEnvironment } : {}),
  });

  // Handle top-level version requests before backend resolution/auth flows.
  if (isTopLevelVersionRequest(args)) {
    console.log(packageJson.version);
    return;
  }
  if (isTopLevelHelpRequest(args)) {
    await ensureMergedAgentCommandRegistryLoaded();
    console.log(buildRootHelpText());
    return;
  }

  // If --version is passed - do not log, its likely daemon inquiring about our version
  if (!args.includes('--version')) {
    debugCliStart(rawArgv);
  }

  // Prefix-only global flags are consumed before this dispatch, so version/help
  // must be rechecked before command dispatch can fall through to the default agent.
  if (isTopLevelVersionRequest(args)) {
    console.log(packageJson.version);
    return;
  }
  if (isTopLevelHelpRequest(args)) {
    await ensureMergedAgentCommandRegistryLoaded();
    console.log(buildRootHelpText());
    return;
  }

  // Check if first argument is a subcommand
  const subcommand = args[0];
  let commandDescriptor = subcommand ? findCommandDispatchDescriptor(subcommand) : null;
  let mergedCommandRegistryForSubcommand = false;

  if (
    !commandDescriptor
    && subcommand
    && !isStaticCommandSurfaceProviderPlaceholder(subcommand)
    && await failClosedReservedRootCommand(args, subcommand)
  ) {
    return;
  }

  if (!commandDescriptor && subcommand) {
    await ensureMergedAgentCommandRegistryLoaded();
    mergedCommandRegistryForSubcommand = true;
    commandDescriptor = findCommandDispatchDescriptor(subcommand);
  }

  applyCommandDaemonAutostartDefaultPolicy({
    args,
    env: process.env,
    policy: commandDescriptor?.policy,
  });

  applyDaemonAutostartEnvForInvocation({ args, env: process.env });

  const pluginTmuxMode = resolvePluginCommandTmuxMode(args);
  const isHelpOrVersionRequest = args.includes('-h') || args.includes('--help') || args.includes('-v') || args.includes('--version');
  const isRunningInTmux = terminalRuntime?.mode === 'tmux' || Boolean(process.env.TMUX?.trim());

  // Headless tmux launcher (CLI flow)
  if (args.includes('--tmux')) {
    // If user is asking for help/version, don't start a session.
    if (isHelpOrVersionRequest) {
      const idx = args.indexOf('--tmux');
      if (idx !== -1) args.splice(idx, 1);
    } else {
      if (pluginTmuxMode === 'forbidden' || (subcommand && !isTmuxAllowedCommand(subcommand))) {
        await rejectTmuxInvocation(args, '--tmux can only be used when starting a session.');
        return;
      }
      await launchCommandInTmux(args, subcommand);
      return;
    }
  }
  if (pluginTmuxMode === 'forbidden' && isRunningInTmux && !isHelpOrVersionRequest) {
    await rejectTmuxInvocation(args, 'This plugin command cannot run inside tmux.');
    return;
  }
  if (pluginTmuxMode === 'required' && !isRunningInTmux && !isHelpOrVersionRequest) {
    await launchCommandInTmux(args, subcommand);
    return;
  }
  let disposePluginSignal: (() => void) | undefined;
  const ownsInterruptSignal = pluginTmuxMode !== null
    || (subcommand === 'plugins' && args[1] === 'dev');
  if (ownsInterruptSignal && !signal) {
    const commandAbort = new AbortController();
    const onSigint = () => commandAbort.abort(new Error('Plugin command interrupted by SIGINT'));
    const onSigterm = () => commandAbort.abort(new Error('Plugin command interrupted by SIGTERM'));
    process.once('SIGINT', onSigint);
    process.once('SIGTERM', onSigterm);
    signal = commandAbort.signal;
    disposePluginSignal = () => {
      process.removeListener('SIGINT', onSigint);
      process.removeListener('SIGTERM', onSigterm);
    };
  }
  let commandHandler = commandDescriptor?.handler ?? (subcommand ? commandRegistry[subcommand] : undefined);
  if (!commandHandler && subcommand && !mergedCommandRegistryForSubcommand) {
    await ensureMergedAgentCommandRegistryLoaded();
    commandDescriptor = findCommandDispatchDescriptor(subcommand);
    commandHandler = commandDescriptor?.handler ?? commandRegistry[subcommand];
  }
  if (commandHandler) {
    try {
      await commandHandler(buildCommandContext(args));
    } finally {
      disposePluginSignal?.();
    }
    return;
  }
  if (subcommand && await failClosedReservedRootCommand(args, subcommand)) {
    return;
  }

  const [{ requireCatalogEntry }, { DEFAULT_CATALOG_AGENT_ID }] = await Promise.all([
    import('@/agent/catalog/registry'),
    import('@/agent/catalog/ids'),
  ]);
  const defaultEntry = requireCatalogEntry(DEFAULT_CATALOG_AGENT_ID);
  if (!defaultEntry.getCliCommandHandler) {
    throw new Error(`Default agent '${DEFAULT_CATALOG_AGENT_ID}' has no CLI command handler registered`);
  }
  const defaultHandler = await defaultEntry.getCliCommandHandler();
  await defaultHandler(buildCommandContext(args));
}
