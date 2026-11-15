import type { TerminalRuntimeFlags } from '@/terminal/runtime/terminalRuntimeFlags';
import {
  commandRegistry,
  ensureMergedAgentCommandRegistryLoaded,
  findCommandDispatchDescriptor,
  isAgentCliCommandRoot,
  resolveAdmittedActionCliCommand,
  resolvePluginCommandTmuxMode,
  type CommandContext,
} from '@/cli/commandRegistry';
import {
  findCommandSurfaceEntry,
  isStaticCommandSurfaceProviderPlaceholder,
  isTmuxAllowedCommand,
} from '@/cli/commandSurfaceManifest';
import { readStartedByArg } from '@/cli/readStartedByArg';
import { HAPPIER_AGENT_RUNTIME_RUNNER_BOOTSTRAP_FILE_ENV_KEY } from '@/agent/runtime/session/process/agentRuntimeRunnerEnvironment';
import { sessionProcessEnvironment } from '@/agent/runtime/lifecycle/hostedSessionScope';
import { applyDaemonAutostartEnvForInvocation, shouldEnsureDaemonForInvocation } from '@/daemon/daemonAutostartPolicy';
import { printJsonEnvelope, wantsJson } from '@/cli/output/jsonEnvelope';
import { errorFrame } from '@happier-dev/cli-common/output';
import { isTopLevelVersionRequest, printCliVersion } from '@/cli/version';
import { resolveExplicitSpawnScopedEnvironmentFromProcessEnv } from '@/daemon/spawn/spawnExplicitEnvKeysMarker';
import {
  CliApiTokenChildContinuationError,
  redactCliApiTokenArgv,
  takeCliApiTokenEnvironment,
  takePrefixCliApiTokenFlag,
  validateCliApiTokenEnvironment,
  withCliApiToken,
} from '@/auth/cliApiToken';
import type { EphemeralResolvedServerSelection } from '@/server/serverSelection';
import { argvBeforeOptionTerminator, readFlagValue } from '@/cli/commands/shared/argvFlags';
import { isFamilyHelpRequest, isTopLevelHelpRequest } from './processArgs';

function isCredentialFreeInvocation(args: readonly string[]): boolean {
  if (isTopLevelVersionRequest(args) || args[0] === 'completion') return true;
  return argvBeforeOptionTerminator(args).some((arg) => arg === '--help' || arg === '-h');
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
  for (const arg of argvBeforeOptionTerminator(args)) {
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

async function reportOrganizationPolicyDiagnostic(visible: boolean): Promise<void> {
  const { configuration } = await import('@/configuration');
  if (configuration.organizationPolicy.status !== 'invalid') return;
  const { logger } = await import('@/ui/logger');
  const { path, code } = configuration.organizationPolicy.error;
  const diagnostic = `organization_policy_invalid: ${path} (${code})`;
  if (visible) logger.warn(diagnostic);
  else logger.warnLocalFile(diagnostic);
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

  console.error(errorFrame(message));
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
  console.error(errorFrame(message));
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
  console.error(errorFrame(message));
  process.exit(1);
}

async function applyGlobalInvocationOptions(
  argsRaw: readonly string[],
  ambientApiToken: ReturnType<typeof takeCliApiTokenEnvironment>,
): Promise<Readonly<{
  args: string[];
  apiToken: string | null;
  explicitServerSelection: EphemeralResolvedServerSelection | null;
}>> {
  let args = [...argsRaw];
  let apiToken: string | null = null;
  let explicitServerSelection: EphemeralResolvedServerSelection | null = null;

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
    const resolved = await applyEphemeralServerSelectionFromPrefixArgs(args);
    if (resolved.rest.length === args.length) break;
    args = resolved.rest;
    if (resolved.selection) explicitServerSelection = resolved.selection;
  }

  // Validate the env form at the same CLI boundary when it remains the selected
  // credential. A valid explicit flag deliberately wins over an irrelevant env value.
  // Credential-free local information surfaces still consume and clear the ambient
  // variable, but never need to parse it.
  if (
    apiToken === null
    && ambientApiToken !== null
    && !isCredentialFreeInvocation(args)
  ) {
    apiToken = validateCliApiTokenEnvironment(ambientApiToken);
  }

  return { args, apiToken, explicitServerSelection };
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
      const code = error instanceof CliApiTokenChildContinuationError
        ? error.code
        : 'tmux_launch_failed';
      await printJsonEnvelope(
        {
          ok: false,
          kind: 'cli_dispatch',
          error: {
            code,
            message,
          },
        },
        { exitCode: 1 },
      );
      return;
    }
    console.error(errorFrame(message));
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
  /** @internal Trusted explicit selection retained across recursive global-option dispatch. */
  explicitServerSelection?: EphemeralResolvedServerSelection;
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
      ...(globalOptions.explicitServerSelection
        ? { explicitServerSelection: globalOptions.explicitServerSelection }
        : {}),
    });
    if (globalOptions.apiToken !== null) {
      await withCliApiToken(globalOptions.apiToken, dispatchWithGlobalOptions);
      return;
    }
    await dispatchWithGlobalOptions();
    return;
  }

  const isPrimaryRunner = readStartedByArg(argvBeforeOptionTerminator(params.args)).value === 'daemon';
  if (isPrimaryRunner && !isCredentialFreeInvocation(params.args)) {
    const { runWithRunnerHomeTransport } = await import('@/api/connection/runWithRunnerHomeTransport');
    return await runWithRunnerHomeTransport(() => dispatchSelectedCli(params), params.signal);
  }
  return await dispatchSelectedCli(params);
}

async function dispatchSelectedCli(params: Parameters<typeof dispatchCli>[0]): Promise<void> {
  let args = [...params.args];
  const globalOptionArgs = argvBeforeOptionTerminator(args);
  const { terminalRuntime, rawArgv } = params;
  let signal = params.signal;
  let sessionStart: CommandContext['sessionStart'];
  // A Session added to a session host reads its own environment, never the host's.
  const invocationEnv = sessionProcessEnvironment();
  const scopedEnvironment =
    resolveExplicitSpawnScopedEnvironmentFromProcessEnv(invocationEnv);
  const buildCommandContext = async (
    contextArgs: string[],
    startsSession: boolean,
  ): Promise<CommandContext> => {
    await reportOrganizationPolicyDiagnostic(!startsSession);
    return ({
    args: contextArgs,
    rawArgv,
    terminalRuntime: startsSession
      ? invocationEnv.HERDR_ENV === '1'
        ? await (await import('@/terminal/runtime/inheritedHerdrRuntime')).resolveInheritedHerdrRuntime({ terminalRuntime, env: invocationEnv })
        : (await import('@/terminal/runtime/inheritedZellijRuntime')).resolveInheritedZellijRuntime({ terminalRuntime, env: invocationEnv })
      : terminalRuntime,
    ...(signal ? { signal } : {}),
    ...(params.explicitServerSelection
      ? { explicitServerSelection: params.explicitServerSelection }
      : {}),
    ...(scopedEnvironment ? { scopedEnvironment } : {}),
    ...(sessionStart ? { sessionStart } : {}),
    });
  };

  // Handle top-level version requests before backend resolution/auth flows.
  if (isTopLevelVersionRequest(args)) {
    printCliVersion();
    return;
  }
  if (isTopLevelHelpRequest(args)) {
    await reportOrganizationPolicyDiagnostic(true);
    const { printRootHelp } = await import('./rootHelp');
    await printRootHelp();
    return;
  }
  if (isFamilyHelpRequest(args)) {
    await reportOrganizationPolicyDiagnostic(true);
    const { tryPrintFamilyHelp } = await import('./familyHelp');
    if (await tryPrintFamilyHelp(args)) return;
  }

  // If --version is passed - do not log, its likely daemon inquiring about our version
  if (!globalOptionArgs.includes('--version')) {
    debugCliStart(rawArgv);
  }

  // Check if first argument is a subcommand
  const subcommand = args[0];
  const runnerBootstrapFilePath = readStartedByArg(globalOptionArgs).value === 'daemon'
    ? invocationEnv[HAPPIER_AGENT_RUNTIME_RUNNER_BOOTSTRAP_FILE_ENV_KEY]?.trim()
    : undefined;
  let commandDescriptor = subcommand ? findCommandDispatchDescriptor(subcommand) : null;
  let mergedCommandRegistryForSubcommand = false;
  let standaloneAgentCatalog: Awaited<ReturnType<typeof ensureMergedAgentCommandRegistryLoaded>> | undefined;

  if (
    !commandDescriptor
    && subcommand
    && !isStaticCommandSurfaceProviderPlaceholder(subcommand)
    && await failClosedReservedRootCommand(args, subcommand)
  ) {
    return;
  }

  if (subcommand && (!commandDescriptor || runnerBootstrapFilePath)) {
    standaloneAgentCatalog = await ensureMergedAgentCommandRegistryLoaded({ commandRoot: subcommand,
      ...(runnerBootstrapFilePath ? { runnerBootstrapFilePath } : {}),
    });
    mergedCommandRegistryForSubcommand = true;
    commandDescriptor = findCommandDispatchDescriptor(subcommand);
  }

  applyCommandDaemonAutostartDefaultPolicy({
    args: [...globalOptionArgs],
    env: invocationEnv,
    policy: commandDescriptor?.policy,
  });

  if (commandDescriptor) applyDaemonAutostartEnvForInvocation({ args: [...globalOptionArgs], env: invocationEnv });

  const pluginTmuxMode = resolvePluginCommandTmuxMode(globalOptionArgs);
  const isHelpOrVersionRequest = globalOptionArgs.includes('-h') || globalOptionArgs.includes('--help') || globalOptionArgs.includes('-v') || globalOptionArgs.includes('--version');
  const isRunningInTmux = terminalRuntime?.mode === 'tmux' || Boolean(invocationEnv.TMUX?.trim());

  // Headless tmux launcher (CLI flow)
  if (globalOptionArgs.includes('--tmux')) {
    // If user is asking for help/version, don't start a session.
    if (isHelpOrVersionRequest) {
      const idx = globalOptionArgs.indexOf('--tmux');
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

  // Resolve the admitted compiled leaf before establishing command-scoped
  // cancellation. Signal ownership belongs to this dispatch, not to an Action
  // definition or parser, and the same signal must reach both compiled leaves
  // and the retained low-level `actions invoke` host.
  const actionCliCommand = subcommand ? await resolveAdmittedActionCliCommand(args) : null;
  let disposeCommandSignal: (() => void) | undefined;
  const ownsInterruptSignal = actionCliCommand !== null
    || (subcommand === 'actions' && args[1] === 'invoke')
    || pluginTmuxMode !== null
    || (subcommand === 'plugins' && args[1] === 'dev')
    || (subcommand === 'daemon' && (args[1] === 'restart-session-runners'
      || (args[1] === 'restart' && args.includes('--restart-session-runners'))))
    || subcommand === 'auth'
    || subcommand === 'setup'
    || subcommand === 'home'
    || (subcommand === 'tools' && args[1] === 'call'
      && readFlagValue(argvBeforeOptionTerminator(args), '--source') === 'happier');
  if (ownsInterruptSignal && !signal) {
    const commandAbort = new AbortController();
    const onSigint = () => commandAbort.abort(new Error('Command interrupted by SIGINT'));
    const onSigterm = () => commandAbort.abort(new Error('Command interrupted by SIGTERM'));
    process.once('SIGINT', onSigint);
    process.once('SIGTERM', onSigterm);
    signal = commandAbort.signal;
    disposeCommandSignal = () => {
      process.removeListener('SIGINT', onSigint);
      process.removeListener('SIGTERM', onSigterm);
    };
  }
  try {
    // Workflow documents share the `workflow` root with compiled Action
    // commands. Keep that specialized path lazy: importing it for unrelated
    // commands also imports the Action execution dependencies before their
    // command surface has been selected.
    if (subcommand === 'workflow') {
      const { tryHandleWorkflowDocumentCliCommand } = await import('@/cli/actions/workflowDocumentCommands');
      if (await tryHandleWorkflowDocumentCliCommand({ argv: args, ...(signal ? { signal } : {}) })) return;
    }

    // A Team logo is inline bytes on the wire, so the terminal's local-file
    // form is adapted to that same input before the compiled command runs. Kept
    // lazy for the same reason the workflow document path is.
    if (subcommand === 'teams') {
      const { tryHandleTeamLogoFileCliCommand } = await import('@/cli/commands/teams/teamLogoCommand');
      if (await tryHandleTeamLogoFileCliCommand({ argv: args, ...(signal ? { signal } : {}) })) return;
    }

    if (subcommand === 'agents' || subcommand === 'agent' || subcommand === 'install' && args[1] === 'provider') {
      const { tryHandleAgentCliCommand } = await import('@/cli/actions/adapters/agentsArgv');
      if (await tryHandleAgentCliCommand({ argv: args, ...(signal ? { signal } : {}) })) return;
    }

    if (subcommand === 'mcp') {
      const { tryHandleMcpServerCliCommand } = await import('@/cli/actions/adapters/mcpServersArgv');
      if (await tryHandleMcpServerCliCommand({ argv: args, ...(signal ? { signal } : {}) })) return;
    }

    if (subcommand === 'registries') {
      const { tryHandleRegistrySourceCliCommand } = await import('@/cli/actions/adapters/registrySourcesArgv');
      if (await tryHandleRegistrySourceCliCommand({ argv: args, ...(signal ? { signal } : {}) })) return;
    }
    if (subcommand === 'skills') {
      const { tryHandleSkillsCliCommand } = await import('@/cli/actions/skillsNameArgAdapter');
      if (await tryHandleSkillsCliCommand({ argv: args, ...(signal ? { signal } : {}) })) return;
    }

    // An exact compiled Action leaf wins only once the one registry has resolved
    // its path owner; every other spelling under the same root — including
    // multi-step workflows and help — still reaches the dedicated root handler.
    if (actionCliCommand) {
      const { runCompiledActionCliCommand } = await import('@/cli/actions/executeCommand');
      await runCompiledActionCliCommand({
        command: actionCliCommand,
        argv: args,
        ...(signal ? { signal } : {}),
      });
      return;
    }

    let commandHandler = commandDescriptor?.handler ?? (subcommand ? commandRegistry[subcommand] : undefined);
    if (!commandHandler && subcommand && !mergedCommandRegistryForSubcommand) {
      standaloneAgentCatalog = await ensureMergedAgentCommandRegistryLoaded({ commandRoot: subcommand });
      commandDescriptor = findCommandDispatchDescriptor(subcommand);
      commandHandler = commandDescriptor?.handler ?? commandRegistry[subcommand];
    }
    if (commandHandler) {
      await commandHandler(await buildCommandContext(
        args,
        subcommand === 'resume' || (subcommand !== undefined && isAgentCliCommandRoot(subcommand)),
      ));
      return;
    }
    if (subcommand && await failClosedReservedRootCommand(args, subcommand)) {
      return;
    }

    const [{ requireCatalogEntry }, { DEFAULT_CATALOG_AGENT_ID }, { partitionProviderSessionArgs }] = await Promise.all([
      import('@/agent/catalog/registry'), import('@/agent/catalog/ids'), import('@/cli/providerSessionArgPartition'),
    ]);
    const parsed = partitionProviderSessionArgs({ args, providerSubcommand: null });
    const prepared = parsed.profileQuery && !isHelpOrVersionRequest
      ? await (await import('@/cli/profileSessionStart')).prepareProfileSessionStart({
          profileQuery: parsed.profileQuery, startedBy: parsed.startedBy, refreshRequested: parsed.refreshSettings,
        }) : null;
    sessionStart = prepared?.sessionStart;
    const target = prepared?.backendTarget;
    if (target && !standaloneAgentCatalog) standaloneAgentCatalog = await ensureMergedAgentCommandRegistryLoaded();
    const { resolveSessionCreationAgentTarget } = await import('@/session/creation/resolveSessionCreationAgentTarget');
    const selectedAgentId = target?.kind === 'agent'
      ? resolveSessionCreationAgentTarget(target, standaloneAgentCatalog)?.agentId : target?.backendId ?? DEFAULT_CATALOG_AGENT_ID;
    if (!selectedAgentId) throw new Error('Profile default Agent is not installed or unavailable');
    const entry = standaloneAgentCatalog?.catalogEntriesById[selectedAgentId] ?? requireCatalogEntry(selectedAgentId);
    applyCommandDaemonAutostartDefaultPolicy({ args: [...globalOptionArgs], env: invocationEnv, policy: entry.cliCommandPolicy });
    applyDaemonAutostartEnvForInvocation({ args: [...globalOptionArgs], env: invocationEnv });
    if (target?.kind === 'agent' && target.definitionId !== undefined) {
      const { handleConfiguredAcpCatalogCliCommand } = await import('@/agent/acp/catalog/configured/handleCatalogCliCommand');
      await handleConfiguredAcpCatalogCliCommand(await buildCommandContext([...args, '--backend', target.definitionId], true));
      return;
    }
    if (!entry.getCliCommandHandler) {
      throw new Error(`Agent '${selectedAgentId}' has no CLI command handler registered`);
    }
    const handler = await entry.getCliCommandHandler();
    await handler(await buildCommandContext(args, true));
  } finally {
    disposeCommandSignal?.();
  }
}
