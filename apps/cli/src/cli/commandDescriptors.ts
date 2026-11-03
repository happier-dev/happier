import type { CommandDispatchPolicy, CommandSurfaceDescriptorInput } from '@/agent/runtime/registry/commandContracts';
import type { CommandHandler } from './commandRegistry';
import { FIRST_CLASS_SESSION_COMMANDS } from './firstClassSessionCommands';
import { SESSION_RESUME_HELP_LABEL } from './commands/session/shared/sessionCommandLabels';
import type { ResolvedCommandContribution } from '@/plugins/projection/registry/types';
import type { ContributionAvailabilityDecision } from '@happier-dev/protocol/plugins/contributions/public-types';
import { findCliCommandPathConflicts, type CliCommandPathClaim } from './commandPathClaims';

export type StaticCommandDescriptor = Readonly<{
  handler?: CommandHandler;
  help?: CommandHandler;
  /** This family accepts the literal `help` in its subcommand position. */
  helpSubcommand?: boolean;
  policy?: CommandDispatchPolicy;
  surface: Readonly<Omit<CommandSurfaceDescriptorInput, 'command'>>;
}>;

type CommandHandlerLoader = () => Promise<CommandHandler>;

export function lazyCommandHandler(loadHandler: CommandHandlerLoader): CommandHandler {
  let handlerPromise: Promise<CommandHandler> | null = null;
  return async (context) => {
    handlerPromise ??= loadHandler();
    const handler = await handlerPromise;
    await handler(context);
  };
}

const handleAttachCliCommand = lazyCommandHandler(async () => (await import('./commands/attach')).handleAttachCliCommand);
const handleHerdrCliCommand = lazyCommandHandler(async () => (await import('./commands/herdr')).handleHerdrCliCommand);
const handleActionsCliCommand = lazyCommandHandler(async () => (await import('./commands/actions')).handleActionsCliCommand);
const handleBrowserCliCommand = lazyCommandHandler(async () => (await import('./commands/browser')).handleBrowserCliCommand);
const handleAutomationCliCommand = lazyCommandHandler(async () => (await import('./commands/automation')).handleAutomationCliCommand);
const handleConfiguredAcpCatalogCliCommand = lazyCommandHandler(async () => (
  await import('@/agent/acp/catalog/configured/handleCatalogCliCommand')
).handleConfiguredAcpCatalogCliCommand);
const handleAuthCliCommand = lazyCommandHandler(async () => (await import('./commands/auth')).handleAuthCliCommand);
const handleBugReportCliCommand = lazyCommandHandler(async () => (await import('./commands/bugReport')).handleBugReportCliCommand);
const handleCapabilitiesCliCommand = lazyCommandHandler(async () => (await import('./commands/capabilities')).handleCapabilitiesCliCommand);
const handleConnectCliCommand = lazyCommandHandler(async () => (await import('./commands/connect')).handleConnectCliCommand);
const handleCompletionCliCommand = lazyCommandHandler(async () => (await import('./commands/completion')).handleCompletionCliCommand);
const handleDaemonCliCommand = lazyCommandHandler(async () => (await import('./commands/daemon')).handleDaemonCliCommand);
const handleDoctorCliCommand = lazyCommandHandler(async () => (await import('./commands/doctor')).handleDoctorCliCommand);
const handleInstallCliCommand = lazyCommandHandler(async () => (await import('./commands/install')).handleInstallCliCommand);
const handleLogoutCliCommand = lazyCommandHandler(async () => (await import('./commands/logout')).handleLogoutCliCommand);
const handleHomeCliCommand = lazyCommandHandler(async () => (await import('./commands/home')).handleHomeCliCommand);
const handleMachineCliCommand = lazyCommandHandler(async () => (await import('./commands/machine')).handleMachineCliCommand);
const handleMachinesCliCommand = lazyCommandHandler(async () => (await import('./commands/machines')).handleMachinesCliCommand);
const handleMcpCliCommand = lazyCommandHandler(async () => (await import('./commands/mcp')).handleMcpCliCommand);
const handleNotifyCliCommand = lazyCommandHandler(async () => (await import('./commands/notify')).handleNotifyCliCommand);
const handlePluginsCliCommand = lazyCommandHandler(async () => (await import('./commands/plugins')).handlePluginsCliCommand);
const handleProfilesCliCommand = lazyCommandHandler(async () => (await import('./commands/profiles')).handleProfilesCliCommand);
const handleAgentsCliCommand = lazyCommandHandler(async () => (await import('./commands/agents')).handleAgentsCliCommand);
const handleAgentLaunchCliCommand = lazyCommandHandler(async () => (await import('./commands/agentLaunch')).handleAgentLaunchCliCommand);
const handleProvidersCliCommand = lazyCommandHandler(async () => (await import('./commands/providers')).handleProvidersCliCommand);
const handleRelayCliCommand = lazyCommandHandler(async () => (await import('./commands/relay')).handleRelayCliCommand);
const handleResumeCliCommand = lazyCommandHandler(async () => (await import('./commands/resume')).handleResumeCliCommand);
const handleSetupCliCommand = lazyCommandHandler(async () => (await import('./commands/setup')).handleSetupCliCommand);
const handleSessionCliCommand = lazyCommandHandler(async () => (await import('./commands/session/index')).handleSessionCliCommand);
const handleServerCliCommand = lazyCommandHandler(async () => (await import('./commands/server')).handleServerCliCommand);
const handleSelfCliCommand = lazyCommandHandler(async () => (await import('./commands/self')).handleSelfCliCommand);
const handleSelfUpdateCliCommand = lazyCommandHandler(async () => (await import('./commands/selfUpdate')).handleSelfUpdateCliCommand);
const handleServiceCliCommand = lazyCommandHandler(async () => (await import('./commands/service')).handleServiceCliCommand);
const handleStatusCliCommand = lazyCommandHandler(async () => (await import('./commands/status')).handleStatusCliCommand);
const handleToolsCliCommand = lazyCommandHandler(async () => (await import('./commands/tools')).handleToolsCliCommand);
const handleUninstallCliCommand = lazyCommandHandler(async () => (await import('./commands/uninstall')).handleUninstallCliCommand);
const handleProvidersHelp = lazyCommandHandler(async () => async (context) => (await import('./commands/providers/help')).printProvidersHelp(context.args.includes('--json')));
const handleAuthHelp = lazyCommandHandler(async () => async (context) => (await import('./commands/auth/help')).printAuthFamilyHelp(context.args));
const handleAutomationHelp = lazyCommandHandler(async () => async () => (await import('./commands/automationHelp')).showAutomationHelp());
const handleProfilesHelp = lazyCommandHandler(async () => async () => (await import('./commands/profiles/help')).showProfilesHelp());
const handleMachineHelp = lazyCommandHandler(async () => async () => (await import('./commands/machine/help')).showMachineHelp());
const handleDoctorHelp = lazyCommandHandler(async () => async () => (await import('./commands/doctorHelp')).printDoctorHelp());
const handleSelfHelp = lazyCommandHandler(async () => async () => console.log((await import('./commands/self/help')).usage()));
const handleUninstallHelp = lazyCommandHandler(async () => async () => { process.stdout.write(`${(await import('./commands/uninstallHelp')).usage()}\n`); });
const handleCapabilitiesHelp = lazyCommandHandler(async () => async () => console.log((await import('./commands/capabilitiesHelp')).usage()));
const handleLogoutHelp = lazyCommandHandler(async () => async () => (await import('./commands/auth/help')).showLogoutHelp());
const handleStatusHelp = lazyCommandHandler(async () => async () => console.log((await import('./commands/statusHelp')).STATUS_USAGE));
const handleToolsHelp = lazyCommandHandler(async () => async () => console.log((await import('./commands/toolsHelp')).TOOLS_USAGE));
const handleConfiguredAcpCatalogHelp = lazyCommandHandler(async () => async () => console.log((await import('@/agent/acp/catalog/configured/catalogHelp')).CONFIGURED_ACP_CATALOG_USAGE));
const handleCompletionHelp = lazyCommandHandler(async () => async () => console.log((await import('./commands/completionHelp')).COMPLETION_USAGE));
const handleDaemonHelp = lazyCommandHandler(async () => async () => (await import('./commands/daemonHelp')).printDaemonHelp());
const handleRelayHelp = lazyCommandHandler(async () => async (context) => (await import('./commands/relay/help')).printRelayFamilyHelp(context.args));
const handleServerHelp = lazyCommandHandler(async () => async () => (await import('./commands/server/help')).showServerHelp());
const handleAttachHelp = lazyCommandHandler(async () => async () => (await import('./commands/attachHelp')).printAttachHelp());
const handleResumeHelp = lazyCommandHandler(async () => async () => (await import('./commands/resumeHelp')).printResumeHelp());
const handleHerdrHelp = lazyCommandHandler(async () => async () => console.log((await import('./commands/herdrHelp')).HERDR_USAGE));
const handleBugReportHelp = lazyCommandHandler(async () => async () => console.log((await import('@/diagnostics/bugReportHelp')).bugReportUsage()));
const handleServiceHelp = lazyCommandHandler(async () => async (context) => (await import('@/daemon/service/help')).printDaemonServiceHelp(context.args.includes('--json')));
const handleBrowserHelp = lazyCommandHandler(async () => async (context) => (await import('./commands/browserHelp')).printBrowserFamilyHelp(context.args));
const handleSetupHelp = lazyCommandHandler(async () => async () => (await import('./commands/setupHelp')).printSetupHelp());
const handleMcpHelp = lazyCommandHandler(async () => async (context) => (await import('./commands/mcp/help')).printMcpFamilyHelp(context.args));
const handleConnectHelp = lazyCommandHandler(async () => async () => {
  const [{ printConnectHelp }, { resolveCliHappyHomeDir }] = await Promise.all([
    import('./commands/connect/help'), import('../configuration/resolveCliHappyHomeDir'),
  ]);
  return printConnectHelp(resolveCliHappyHomeDir(process.env));
});
const handleAgentsHelp = lazyCommandHandler(async () => async () => {
  const [{ printAgentsHelp }, { resolveCliHappyHomeDir }] = await Promise.all([
    import('./commands/agents/help'), import('../configuration/resolveCliHappyHomeDir'),
  ]);
  return printAgentsHelp(resolveCliHappyHomeDir(process.env));
});
const handleInstallHelp = lazyCommandHandler(async () => async () => {
  const [{ printInstallHelp }, { resolveCliHappyHomeDir }] = await Promise.all([
    import('./commands/installHelp'), import('../configuration/resolveCliHappyHomeDir'),
  ]);
  return printInstallHelp(resolveCliHappyHomeDir(process.env));
});
const handlePluginsHelp = lazyCommandHandler(async () => async (context) => {
  if (context.args[1] === 'settings') {
    await (await import('./commands/pluginSettingsHelp')).printPluginSettingsHelp(context.args);
    return;
  }
  const [{ renderPluginHelp }, { BUNDLED_CLI_HELP_FACTS }] = await Promise.all([
    import('./commands/pluginsHelp'), import('@/plugins/projection/registry/sources/generatedBundledCliHelpFacts'),
  ]);
  console.log(renderPluginHelp(BUNDLED_CLI_HELP_FACTS.scaffoldUiModes));
});
const handleHomeHelp = lazyCommandHandler(async () => async () => (await import('./commands/home/help')).showHomeHelp());
const handleMachinesHelp = lazyCommandHandler(async () => async () => (await import('./commands/machinesHelp')).showHelp());
const handleActionsHelp = lazyCommandHandler(async () => async () => (await import('./actions/discoveryHelp')).showHelp());
const handleSessionHelp = lazyCommandHandler(async () => async (context) => (await import('./commands/session/help')).printSessionFamilyHelp(context.args));


/**
 * Root help for a friendly path family the Action catalog owns end to end. The
 * catalog declares the paths; a root line is a CLI presentation fact, so only a
 * family named here appears in `happier --help`. Anything else stays dispatchable
 * and self-documenting through its own `--help` without claiming a root line it
 * has no description for.
 */
export const ACTION_CLI_ROOT_HELP: Readonly<Record<string, Readonly<{ label: string; description: string }>>> = {
  teams: { label: 'happier teams', description: 'Manage Teams, members, and Team policy' },
  identity: { label: 'happier identity', description: 'Manage managed identity providers and GitHub Apps' },
  credentials: { label: 'happier credentials', description: 'Manage Team credential resources and usage' },
  secrets: { label: 'happier secrets', description: 'Manage shared Saved Secrets' },
  workflow: { label: 'happier workflow', description: 'Run, inspect, and manage reusable workflows' },
  discussions: { label: 'happier discussions', description: 'Read and manage Home discussions' },
};

/** First-class static entries that are only projections into these Actions. */
const ACTION_OWNED_STATIC_PATHS = new Set(['list', 'ls', 'send', 'stop', 'wait', 'notify']);

/**
 * Dedicated workflow leaves below multiplexed roots. They are intentionally
 * not Action commands, so an Action may be their sibling but may not claim the
 * same path or a descendant that the workflow would otherwise consume.
 */
const DEDICATED_STATIC_COMMAND_PATHS: readonly (readonly string[])[] = Object.freeze([
  Object.freeze(['browser', 'sandbox']),
  Object.freeze(['actions', 'invoke']),
  Object.freeze(['agents', 'list']),
  Object.freeze(['agents', 'status']),
  Object.freeze(['agents', 'probe']),
  Object.freeze(['agents', 'auth']),
  Object.freeze(['agents', 'setup']),
  Object.freeze(['agent', 'list']),
  Object.freeze(['agent', 'status']),
  Object.freeze(['agent', 'probe']),
  Object.freeze(['agent', 'auth']),
  Object.freeze(['agent', 'setup']),
  Object.freeze(['session', 'actions', 'describe']),
  Object.freeze(['session', 'actions', 'execute']),
  Object.freeze(['session', 'actions', 'list']),
  Object.freeze(['session', 'create']),
  Object.freeze(['session', 'delegate', 'start']),
  Object.freeze(['session', 'history']),
  Object.freeze(['session', 'plan', 'start']),
  Object.freeze(['session', 'review', 'start']),
  Object.freeze(['session', 'run', 'action']),
  Object.freeze(['session', 'voice-agent', 'start']),
  Object.freeze(['session', 'voice_agent', 'start']),
]);

export function assertComposedCommandPathsAreUnambiguous(
  claims: readonly CliCommandPathClaim[],
): void {
  const conflicts = findCliCommandPathConflicts(claims);
  if (conflicts.length === 0) return;
  throw new Error(`CLI command path collision: ${conflicts.map((conflict) => (
    `${conflict.left.source} ${conflict.left.ownerId} owns "${conflict.left.path.join(' ')}" but ${conflict.right.source} ${conflict.right.ownerId} owns "${conflict.right.path.join(' ')}"`
  )).join('; ')}.`);
}

export function assertActionCommandPathsFitStaticRegistry(
  commands: readonly Readonly<{
    actionId: string;
    path: readonly string[];
  }>[],
): void {
  const staticClaims: CliCommandPathClaim[] = Object.keys(staticCommandDescriptors)
    .filter((command) => (
      !ACTION_OWNED_STATIC_PATHS.has(command)
      && !isStaticCommandSurfaceProviderPlaceholder(command)
    ))
    .map((command) => ({
      source: 'static',
      ownerId: command,
      path: [command],
      // A static root is a dispatcher namespace. It keeps unknown/dedicated
      // leaves while admitted Action leaves may migrate into the same family.
      allowsDescendants: true,
    }));
  const dedicatedClaims: CliCommandPathClaim[] = DEDICATED_STATIC_COMMAND_PATHS.map((path) => ({
    source: 'static',
    ownerId: path.join(' '),
    path,
  }));
  const actionClaims: CliCommandPathClaim[] = commands.map((command) => {
    const namespace = command.path.join('.');
    const isNamespaceList = command.actionId === `${namespace}.list`;
    return {
      source: 'action',
      ownerId: command.actionId,
      path: command.path,
      // Friendly spellings of the same Action and preview/execute-style family
      // members may extend a path owned by that Action. A list Action declared
      // at its own namespace is also the default beside that namespace's leaves;
      // the compiler selects the longest matching path for their dispatch.
      ...(commands.some((candidate) => (
        candidate !== command
        && (candidate.actionId === command.actionId
          || candidate.actionId.startsWith(`${command.actionId}.`)
          || (isNamespaceList && candidate.actionId.startsWith(`${namespace}.`)))
        && command.path.length < candidate.path.length
        && command.path.every((segment, index) => candidate.path[index] === segment)
      )) ? { allowsDescendants: true } : {}),
    };
  });
  assertComposedCommandPathsAreUnambiguous([
    ...staticClaims,
    ...dedicatedClaims,
    ...actionClaims,
  ]);
}


export function isStaticCommandSurfaceReserved(command: string): boolean {
  return Object.prototype.hasOwnProperty.call(staticCommandDescriptors, command);
}

export function isStaticCommandSurfaceProviderPlaceholder(command: string): boolean {
  const entry = staticCommandDescriptors[command];
  return Boolean(entry && !entry.handler
    && typeof entry.surface.rootHelpLabel === 'string'
    && typeof entry.surface.rootHelpDescription === 'string');
}


export function listCollidingAgentCommandRoots(
  entries: readonly Readonly<{ cliSubcommand: string }>[],
): readonly string[] {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    counts.set(entry.cliSubcommand, (counts.get(entry.cliSubcommand) ?? 0) + 1);
  }
  return Object.freeze([...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([root]) => root)
    .sort());
}


export type AgentCommandMetadata = Readonly<{
  id: string;
  cliSubcommand: string;
  title?: string;
  rootHelpLabel?: string;
  rootHelpDescription?: string;
  rootHelpDetail?: string;
  allowTmux?: boolean;
}>;

export type BundledPluginCommandMetadata = Readonly<{
  pluginId: string;
  agents: readonly AgentCommandMetadata[];
  commands: readonly (ResolvedCommandContribution & Readonly<{ availability: ContributionAvailabilityDecision }>)[];
}>;

/** The shared Agent-root admission for executable dispatch and cold help. */
export function resolveAdmittedAgentCommandMetadata<T extends AgentCommandMetadata>(
  entries: readonly T[],
  actionRoots: ReadonlySet<string>,
): readonly T[] {
  const collisions = new Set(listCollidingAgentCommandRoots(entries));
  return entries.filter((entry) => (
    !collisions.has(entry.cliSubcommand)
    && !actionRoots.has(entry.cliSubcommand)
    && (!isStaticCommandSurfaceReserved(entry.cliSubcommand)
      || isStaticCommandSurfaceProviderPlaceholder(entry.cliSubcommand))
  ));
}

export function projectAgentCommandSurface(entry: AgentCommandMetadata): CommandSurfaceDescriptorInput {
  const title = entry.title?.trim() || entry.cliSubcommand;
  return {
    command: entry.cliSubcommand,
    rootHelpLabel: entry.rootHelpLabel ?? `happier ${entry.cliSubcommand}`,
    rootHelpDescription: entry.rootHelpDescription ?? `Start ${title}`,
    ...(entry.rootHelpDetail ? { rootHelpDetail: entry.rootHelpDetail } : {}),
    allowTmux: entry.allowTmux ?? true,
  };
}

export function projectActionCommandSurface(root: string): CommandSurfaceDescriptorInput {
  const help = ACTION_CLI_ROOT_HELP[root];
  return {
    command: root,
    ...(help ? { rootHelpLabel: help.label, rootHelpDescription: help.description } : {}),
    allowTmux: false,
  };
}

export function listStaticCommandSurfaceEntries(): readonly CommandSurfaceDescriptorInput[] {
  return Object.entries(staticCommandDescriptors).map(([command, entry]) => ({ command, ...entry.surface }));
}

export const DEFAULT_COMMAND_SURFACE: CommandSurfaceDescriptorInput = Object.freeze({
  command: null,
  rootHelpLabel: 'happier [options]',
  rootHelpDescription: 'Start the default backend with mobile control',
  allowTmux: true,
});


const firstClassSessionCommandRegistryEntries: Readonly<Record<string, StaticCommandDescriptor>> = Object.freeze(
  Object.fromEntries(
    FIRST_CLASS_SESSION_COMMANDS.flatMap((sessionCommand) => [
      [sessionCommand.command, {
        handler: sessionCommand.handler,
        ...(!ACTION_OWNED_STATIC_PATHS.has(sessionCommand.command) ? { help: sessionCommand.handler } : {}),
        surface: {
          rootHelpLabel: sessionCommand.rootHelpLabel,
          rootHelpDescription: sessionCommand.rootHelpDescription,
          allowTmux: false,
        },
      }],
      ...(sessionCommand.aliases ?? []).map((alias) => [alias, {
        handler: sessionCommand.handler,
        ...(!ACTION_OWNED_STATIC_PATHS.has(sessionCommand.command) ? { help: sessionCommand.handler } : {}),
        surface: { allowTmux: false },
      }]),
    ]),
  ) as Record<string, StaticCommandDescriptor>,
);

export const staticCommandDescriptors: Readonly<Record<string, StaticCommandDescriptor>> = {
  'agent-launch': { handler: handleAgentLaunchCliCommand, surface: { allowTmux: false } },
  browser: { handler: handleBrowserCliCommand, helpSubcommand: true, help: handleBrowserHelp, surface: { rootHelpLabel: 'happier browser', rootHelpDescription: 'Browser Actions and managed Chromium sandbox setup', allowTmux: false } },
  setup: { handler: handleSetupCliCommand, helpSubcommand: true, help: handleSetupHelp, surface: { rootHelpLabel: 'happier setup', rootHelpDescription: 'Connect this computer to an existing Home', allowTmux: false } },
  auth: { handler: handleAuthCliCommand, helpSubcommand: true, help: handleAuthHelp, surface: { rootHelpLabel: 'happier auth', rootHelpDescription: 'Manage authentication', allowTmux: false } },
  automation: { handler: handleAutomationCliCommand, helpSubcommand: true, help: handleAutomationHelp, surface: { rootHelpLabel: 'happier automation', rootHelpDescription: 'Trigger and manage automations', allowTmux: false } },
  automations: { handler: handleAutomationCliCommand, helpSubcommand: true, help: handleAutomationHelp, surface: { allowTmux: false } },
  mcp: { handler: handleMcpCliCommand, helpSubcommand: true, help: handleMcpHelp, surface: { rootHelpLabel: 'happier mcp', rootHelpDescription: 'Expose the MCP server and manage MCP clients', allowTmux: false } },
  // Backwards-compatible alias for the MCP command namespace.
  // Prefer `happier mcp ...` in docs and help output.
  bridge: { handler: handleMcpCliCommand, helpSubcommand: true, help: handleMcpHelp, surface: { allowTmux: false } },
  codex: { surface: { rootHelpLabel: 'happier codex', rootHelpDescription: 'Start Codex mode', allowTmux: true } },
  gemini: { surface: { rootHelpLabel: 'happier gemini', rootHelpDescription: 'Start Gemini mode (ACP)', allowTmux: true } },
  connect: { handler: handleConnectCliCommand, helpSubcommand: true, help: handleConnectHelp, surface: { rootHelpLabel: 'happier connect', rootHelpDescription: 'Connect AI vendor API keys', allowTmux: false } },
  completion: { handler: handleCompletionCliCommand, help: handleCompletionHelp, surface: { rootHelpLabel: 'happier completion', rootHelpDescription: 'Generate shell completion or list completion candidates', allowTmux: false } },
  agents: { handler: handleAgentsCliCommand, helpSubcommand: true, help: handleAgentsHelp, surface: { rootHelpLabel: 'happier agents', rootHelpDescription: 'Install and manage agent CLIs', allowTmux: false } },
  agent: { handler: handleAgentsCliCommand, helpSubcommand: true, help: handleAgentsHelp, surface: { allowTmux: false } },
  providers: { handler: handleProvidersCliCommand, helpSubcommand: true, help: handleProvidersHelp, surface: { rootHelpLabel: 'happier providers', rootHelpDescription: 'Configure model providers and connections', allowTmux: false } },
  provider: { handler: handleProvidersCliCommand, helpSubcommand: true, help: handleProvidersHelp, surface: { allowTmux: false } },
  profiles: { handler: handleProfilesCliCommand, helpSubcommand: true, help: handleProfilesHelp, surface: { rootHelpLabel: 'happier profiles', rootHelpDescription: 'Manage Agent launch profiles', allowTmux: false } },
  profile: { handler: handleProfilesCliCommand, helpSubcommand: true, help: handleProfilesHelp, surface: { allowTmux: false } },
  plugins: { handler: handlePluginsCliCommand, helpSubcommand: true, help: handlePluginsHelp, surface: { rootHelpLabel: 'happier plugins', rootHelpDescription: 'Discover and manage plugins', allowTmux: false } },
  notify: { handler: handleNotifyCliCommand, surface: { rootHelpLabel: 'happier notify', rootHelpDescription: 'Send a notification using your delivery policy', allowTmux: false } },
  install: { handler: handleInstallCliCommand, helpSubcommand: true, help: handleInstallHelp, surface: { rootHelpLabel: 'happier install', rootHelpDescription: 'Install agent CLIs and helpers', allowTmux: false } },
  status: { handler: handleStatusCliCommand, help: handleStatusHelp, surface: { rootHelpLabel: 'happier status', rootHelpDescription: 'Show system status and recommended repairs', allowTmux: false } },
  service: { handler: handleServiceCliCommand, help: handleServiceHelp, surface: { rootHelpLabel: 'happier service', rootHelpDescription: 'Manage the background service that allows', rootHelpDetail: 'to spawn new sessions away from your computer', allowTmux: false } },
  daemon: { handler: handleDaemonCliCommand, help: handleDaemonHelp, surface: { rootHelpLabel: 'happier daemon', rootHelpDescription: 'Manage daemon status and sessions', allowTmux: false } },
  home: { handler: handleHomeCliCommand, helpSubcommand: true, help: handleHomeHelp, surface: { rootHelpLabel: 'happier home', rootHelpDescription: 'Create, connect devices to, and manage a Personal Home', allowTmux: false } },
  machine: { handler: handleMachineCliCommand, helpSubcommand: true, help: handleMachineHelp, surface: { rootHelpLabel: 'happier machine', rootHelpDescription: 'Set up remote machines over SSH', allowTmux: false } },
  machines: { handler: handleMachinesCliCommand, helpSubcommand: true, help: handleMachinesHelp, surface: { rootHelpLabel: 'happier machines', rootHelpDescription: 'Discover Account machines for API targeting', allowTmux: false } },
  actions: { handler: handleActionsCliCommand, helpSubcommand: true, help: handleActionsHelp, surface: { rootHelpLabel: 'happier actions', rootHelpDescription: 'Discover and invoke built-in and contributed Actions', allowTmux: false } },
  relay: { handler: handleRelayCliCommand, helpSubcommand: true, help: handleRelayHelp, surface: { rootHelpLabel: 'happier relay', rootHelpDescription: 'Advanced runtime and public-ingress operations', allowTmux: false } },
  doctor: { handler: handleDoctorCliCommand, helpSubcommand: true, help: handleDoctorHelp, surface: { rootHelpLabel: 'happier doctor', rootHelpDescription: 'System diagnostics & troubleshooting', allowTmux: false } },
  uninstall: { handler: handleUninstallCliCommand, help: handleUninstallHelp, surface: { rootHelpLabel: 'happier uninstall', rootHelpDescription: 'Uninstall the current managed Happier CLI', allowTmux: false } },
  self: { handler: handleSelfCliCommand, helpSubcommand: true, help: handleSelfHelp, surface: { rootHelpLabel: 'happier self', rootHelpDescription: 'Manage CLI updates and release channels', allowTmux: false } },
  'self-update': { handler: handleSelfUpdateCliCommand, help: handleSelfHelp, surface: { rootHelpLabel: 'happier self-update', rootHelpDescription: 'Update the Happier CLI', allowTmux: false } },
  session: { handler: handleSessionCliCommand, helpSubcommand: true, help: handleSessionHelp, surface: { rootHelpLabel: 'happier session', rootHelpDescription: 'Manage sessions and execution runs', allowTmux: false } },
  ...firstClassSessionCommandRegistryEntries,
  resume: { handler: handleResumeCliCommand, help: handleResumeHelp, surface: { rootHelpLabel: SESSION_RESUME_HELP_LABEL, rootHelpDescription: 'Resume an inactive session', allowTmux: true } },
  // Backwards-compatible plural alias; keep the singular command canonical in help.
  sessions: { handler: handleSessionCliCommand, helpSubcommand: true, help: handleSessionHelp, surface: { allowTmux: false } },
  server: { handler: handleServerCliCommand, helpSubcommand: true, help: handleServerHelp, surface: { rootHelpLabel: 'happier server', rootHelpDescription: 'Manage Happier server profiles', allowTmux: false } },
  attach: { handler: handleAttachCliCommand, help: handleAttachHelp, surface: { rootHelpLabel: 'happier attach <session-id>', rootHelpDescription: 'Attach a terminal to a running session', allowTmux: false } },
  herdr: { handler: handleHerdrCliCommand, help: handleHerdrHelp, surface: { rootHelpLabel: 'happier herdr', rootHelpDescription: 'Open the Herdr terminal host', allowTmux: false } },
  logout: { handler: handleLogoutCliCommand, help: handleLogoutHelp, surface: { allowTmux: false } },
  'acp-catalog': { handler: handleConfiguredAcpCatalogCliCommand, help: handleConfiguredAcpCatalogHelp, surface: { allowTmux: false } },
  'bug-report': { handler: handleBugReportCliCommand, help: handleBugReportHelp, surface: { allowTmux: false } },
  capabilities: { handler: handleCapabilitiesCliCommand, helpSubcommand: true, help: handleCapabilitiesHelp, surface: { allowTmux: false } },
  tools: { handler: handleToolsCliCommand, help: handleToolsHelp, surface: { allowTmux: false } },
};


