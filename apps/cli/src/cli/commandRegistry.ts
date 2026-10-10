import type { TerminalRuntimeFlags } from '@/terminal/runtime/terminalRuntimeFlags';
import type {
  ActionDefinitionV1,
  ConnectedServiceBindingsV2,
  SessionProviderBindingMetadataV1,
  SessionProviderBindingSecurityChangeConfirmationV1,
} from '@happier-dev/protocol';

import type { ResolvedContributionRegistry } from '@/plugins/projection/registry/types';
import { resolvePluginCommandProjection, type PluginCommandProjection } from '@/cli/pluginCommandProjection';
import {
  createCommandDispatchRegistry,
  type CommandDispatchPolicy,
  type CommandDispatchDescriptor as RuntimeCommandDispatchDescriptor,
  type CommandDispatchRegistry as RuntimeCommandDispatchRegistry,
  type CommandSurfaceDescriptorInput,
} from '@/agent/runtime/registry/commandContracts';
import { SESSION_HELP_LINES } from '@/cli/commands/session/shared/sessionCommandUsage';
import { FIRST_CLASS_SESSION_COMMANDS } from '@/cli/firstClassSessionCommands';
import type { CompiledActionCliCommand } from '@/cli/actions/compiledCommands';
import type { EphemeralResolvedServerSelection } from '@/server/serverSelection';
import {
  findCliCommandPathConflicts,
  type CliCommandPathClaim,
} from '@/cli/commandPathClaims';

export type CommandContext = Readonly<{
  args: string[];
  rawArgv: string[];
  terminalRuntime: TerminalRuntimeFlags | null;
  signal?: AbortSignal;
  /** Trusted explicit invocation provenance; contains neither credentials nor persistence authority. */
  explicitServerSelection?: EphemeralResolvedServerSelection;
  /** In-memory only; carries launch-scoped values without argv or process.env. */
  scopedEnvironment?: Readonly<{
    env: Readonly<Record<string, string>>;
    unsetEnvKeys?: readonly string[];
  }>;
  /** Non-secret persisted lifecycle facts for a direct resume/fork boundary. */
  directSessionLaunch?: Readonly<{
    providerBinding?: SessionProviderBindingMetadataV1 | null;
    confirmProviderSecurityChange?: (
      confirmation: SessionProviderBindingSecurityChangeConfirmationV1,
    ) => Promise<boolean>;
    connectedServices?: ConnectedServiceBindingsV2 | null;
    sessionAttachFilePath?: string;
  }>;
}>;

export type CommandHandler = (context: CommandContext) => Promise<void>;
export type CommandDispatchDescriptor = RuntimeCommandDispatchDescriptor<CommandHandler>;
export type CommandDispatchRegistry = RuntimeCommandDispatchRegistry<CommandHandler>;

type CommandRegistryEntry = Readonly<{
  handler?: CommandHandler;
  policy?: CommandDispatchPolicy;
  surface: Readonly<Omit<CommandSurfaceDescriptorInput, 'command'>>;
}>;

type CommandHandlerLoader = () => Promise<CommandHandler>;

function lazyCommandHandler(loadHandler: CommandHandlerLoader): CommandHandler {
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

function lazyPluginCommandHandler(root: string): CommandHandler {
  return lazyCommandHandler(async () => {
    const { handlePluginCommandCliCommand } = await import('./pluginCommandContributions');
    return async (context) => {
      await handlePluginCommandCliCommand(root, context);
    };
  });
}

function lazyActionCliRootHandler(root: string): CommandHandler {
  return lazyCommandHandler(async () => {
    const { handleActionCliRootCommand } = await import('@/cli/actions/rootCommand');
    return async (context) => {
      await handleActionCliRootCommand(root, context);
    };
  });
}

/**
 * Root help for a friendly path family the Action catalog owns end to end. The
 * catalog declares the paths; a root line is a CLI presentation fact, so only a
 * family named here appears in `happier --help`. Anything else stays dispatchable
 * and self-documenting through its own `--help` without claiming a root line it
 * has no description for.
 */
const ACTION_CLI_ROOT_HELP: Readonly<Record<string, Readonly<{ label: string; description: string }>>> = {
  teams: { label: 'happier teams', description: 'Manage Teams, members, and Team policy' },
  identity: { label: 'happier identity', description: 'Manage managed identity providers and GitHub Apps' },
  credentials: { label: 'happier credentials', description: 'Manage Team credential resources and usage' },
  secrets: { label: 'happier secrets', description: 'Manage shared Saved Secrets' },
  workflow: { label: 'happier workflow', description: 'Run, inspect, and manage reusable workflows' },
};

const firstClassSessionCommandRegistryEntries: Readonly<Record<string, CommandRegistryEntry>> = Object.freeze(
  Object.fromEntries(
    FIRST_CLASS_SESSION_COMMANDS.flatMap((sessionCommand) => [
      [sessionCommand.command, {
        handler: sessionCommand.handler,
        surface: {
          rootHelpLabel: sessionCommand.rootHelpLabel,
          rootHelpDescription: sessionCommand.rootHelpDescription,
          allowTmux: false,
        },
      }],
      ...(sessionCommand.aliases ?? []).map((alias) => [alias, {
        handler: sessionCommand.handler,
        surface: { allowTmux: false },
      }]),
    ]),
  ) as Record<string, CommandRegistryEntry>,
);

const staticCommandRegistryEntries: Readonly<Record<string, CommandRegistryEntry>> = {
  browser: { handler: handleBrowserCliCommand, surface: { rootHelpLabel: 'happier browser', rootHelpDescription: 'Browser Actions and managed Chromium sandbox setup', allowTmux: false } },
  setup: { handler: handleSetupCliCommand, surface: { rootHelpLabel: 'happier setup', rootHelpDescription: 'Connect this computer to an existing Home', allowTmux: false } },
  auth: { handler: handleAuthCliCommand, surface: { rootHelpLabel: 'happier auth', rootHelpDescription: 'Manage authentication', allowTmux: false } },
  automation: { handler: handleAutomationCliCommand, surface: { rootHelpLabel: 'happier automation', rootHelpDescription: 'Trigger and manage automations', allowTmux: false } },
  automations: { handler: handleAutomationCliCommand, surface: { allowTmux: false } },
  mcp: { handler: handleMcpCliCommand, surface: { rootHelpLabel: 'happier mcp', rootHelpDescription: 'Expose the MCP server and manage MCP clients', allowTmux: false } },
  // Backwards-compatible alias for the MCP command namespace.
  // Prefer `happier mcp ...` in docs and help output.
  bridge: { handler: handleMcpCliCommand, surface: { allowTmux: false } },
  codex: { surface: { rootHelpLabel: 'happier codex', rootHelpDescription: 'Start Codex mode', allowTmux: true } },
  gemini: { surface: { rootHelpLabel: 'happier gemini', rootHelpDescription: 'Start Gemini mode (ACP)', allowTmux: true } },
  connect: { handler: handleConnectCliCommand, surface: { rootHelpLabel: 'happier connect', rootHelpDescription: 'Connect AI vendor API keys', allowTmux: false } },
  completion: { handler: handleCompletionCliCommand, surface: { rootHelpLabel: 'happier completion', rootHelpDescription: 'Generate shell completion or list completion candidates', allowTmux: false } },
  agents: { handler: handleAgentsCliCommand, surface: { rootHelpLabel: 'happier agents', rootHelpDescription: 'Install and manage agent CLIs', allowTmux: false } },
  agent: { handler: handleAgentsCliCommand, surface: { allowTmux: false } },
  providers: { handler: handleProvidersCliCommand, surface: { rootHelpLabel: 'happier providers', rootHelpDescription: 'Configure model providers and connections', allowTmux: false } },
  provider: { handler: handleProvidersCliCommand, surface: { allowTmux: false } },
  profiles: { handler: handleProfilesCliCommand, surface: { rootHelpLabel: 'happier profiles', rootHelpDescription: 'Manage Agent launch profiles', allowTmux: false } },
  profile: { handler: handleProfilesCliCommand, surface: { allowTmux: false } },
  plugins: { handler: handlePluginsCliCommand, surface: { rootHelpLabel: 'happier plugins', rootHelpDescription: 'Discover and manage plugins', allowTmux: false } },
  notify: { handler: handleNotifyCliCommand, surface: { rootHelpLabel: 'happier notify', rootHelpDescription: 'Send a notification using your delivery policy', allowTmux: false } },
  install: { handler: handleInstallCliCommand, surface: { rootHelpLabel: 'happier install', rootHelpDescription: 'Install agent CLIs and helpers', allowTmux: false } },
  status: { handler: handleStatusCliCommand, surface: { rootHelpLabel: 'happier status', rootHelpDescription: 'Show system status and recommended repairs', allowTmux: false } },
  service: { handler: handleServiceCliCommand, surface: { rootHelpLabel: 'happier service', rootHelpDescription: 'Manage the background service that allows', rootHelpDetail: 'to spawn new sessions away from your computer', allowTmux: false } },
  daemon: { handler: handleDaemonCliCommand, surface: { rootHelpLabel: 'happier daemon', rootHelpDescription: 'Manage daemon status and sessions', allowTmux: false } },
  home: { handler: handleHomeCliCommand, surface: { rootHelpLabel: 'happier home', rootHelpDescription: 'Create, connect devices to, and manage a Personal Home', allowTmux: false } },
  machine: { handler: handleMachineCliCommand, surface: { rootHelpLabel: 'happier machine', rootHelpDescription: 'Set up remote machines over SSH', allowTmux: false } },
  machines: { handler: handleMachinesCliCommand, surface: { rootHelpLabel: 'happier machines', rootHelpDescription: 'Discover Account machines for API targeting', allowTmux: false } },
  actions: { handler: handleActionsCliCommand, surface: { rootHelpLabel: 'happier actions', rootHelpDescription: 'Discover and invoke built-in and contributed Actions', allowTmux: false } },
  relay: { handler: handleRelayCliCommand, surface: { rootHelpLabel: 'happier relay', rootHelpDescription: 'Advanced runtime and public-ingress operations', allowTmux: false } },
  doctor: { handler: handleDoctorCliCommand, surface: { rootHelpLabel: 'happier doctor', rootHelpDescription: 'System diagnostics & troubleshooting', allowTmux: false } },
  uninstall: { handler: handleUninstallCliCommand, surface: { rootHelpLabel: 'happier uninstall', rootHelpDescription: 'Uninstall the current managed Happier CLI', allowTmux: false } },
  self: { handler: handleSelfCliCommand, surface: { rootHelpLabel: 'happier self', rootHelpDescription: 'Manage CLI updates and release channels', allowTmux: false } },
  'self-update': { handler: handleSelfUpdateCliCommand, surface: { rootHelpLabel: 'happier self-update', rootHelpDescription: 'Update the Happier CLI', allowTmux: false } },
  session: { handler: handleSessionCliCommand, surface: { rootHelpLabel: 'happier session', rootHelpDescription: 'Manage sessions and execution runs', allowTmux: false } },
  ...firstClassSessionCommandRegistryEntries,
  resume: { handler: handleResumeCliCommand, surface: { rootHelpLabel: SESSION_HELP_LINES.resume, rootHelpDescription: 'Resume an inactive session', allowTmux: true } },
  // Backwards-compatible plural alias; keep the singular command canonical in help.
  sessions: { handler: handleSessionCliCommand, surface: { allowTmux: false } },
  server: { handler: handleServerCliCommand, surface: { rootHelpLabel: 'happier server', rootHelpDescription: 'Manage Happier server profiles', allowTmux: false } },
  attach: { handler: handleAttachCliCommand, surface: { allowTmux: false } },
  herdr: { handler: handleHerdrCliCommand, surface: { rootHelpLabel: 'happier herdr', rootHelpDescription: 'Open the Herdr terminal host', allowTmux: false } },
  logout: { handler: handleLogoutCliCommand, surface: { allowTmux: false } },
  'acp-catalog': { handler: handleConfiguredAcpCatalogCliCommand, surface: { allowTmux: false } },
  'bug-report': { handler: handleBugReportCliCommand, surface: { allowTmux: false } },
  capabilities: { handler: handleCapabilitiesCliCommand, surface: { allowTmux: false } },
  tools: { handler: handleToolsCliCommand, surface: { allowTmux: false } },
};

const staticCommandRegistry: Readonly<Record<string, CommandHandler>> = Object.freeze(
  Object.fromEntries(
    Object.entries(staticCommandRegistryEntries)
      .filter((entry): entry is [string, CommandRegistryEntry & Readonly<{ handler: CommandHandler }>] => Boolean(entry[1].handler))
      .map(([command, entry]) => [command, entry.handler]),
  ) as Record<string, CommandHandler>,
);

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

function assertActionCommandPathsFitStaticRegistry(
  commands: readonly CompiledActionCliCommand[],
): void {
  const staticClaims: CliCommandPathClaim[] = Object.keys(staticCommandRegistryEntries)
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
  const actionClaims: CliCommandPathClaim[] = commands.map((command) => ({
    source: 'action',
    ownerId: command.actionId,
    path: command.path,
    // Preview/execute-style members of one canonical Action family may extend
    // their family's path. Unrelated Action ids still cannot claim a subtree.
    ...(commands.some((candidate) => (
      candidate !== command
      && candidate.actionId.startsWith(`${command.actionId}.`)
      && command.path.length < candidate.path.length
      && command.path.every((segment, index) => candidate.path[index] === segment)
    )) ? { allowsDescendants: true } : {}),
  }));
  assertComposedCommandPathsAreUnambiguous([
    ...staticClaims,
    ...dedicatedClaims,
    ...actionClaims,
  ]);
}

const mutableCommandRegistry: Record<string, CommandHandler> = { ...staticCommandRegistry };
const mutableCommandPolicies: Record<string, CommandDispatchPolicy | undefined> = Object.fromEntries(
  Object.entries(staticCommandRegistryEntries)
    .filter(([, entry]) => entry.policy)
    .map(([command, entry]) => [command, entry.policy]),
) as Record<string, CommandDispatchPolicy | undefined>;
const mutableCommandSurfaceEntries: Record<string, CommandSurfaceDescriptorInput> = Object.fromEntries(
  Object.entries(staticCommandRegistryEntries).map(([command, entry]) => [command, {
    command,
    ...entry.surface,
  }]),
) as Record<string, CommandSurfaceDescriptorInput>;

const dynamicAgentCommandKeys = new Set<string>();

/** Agent roots admitted by the merged command registry, not arbitrary plugin commands. */
export function isAgentCliCommandRoot(root: string): boolean {
  return dynamicAgentCommandKeys.has(root);
}
const dynamicPluginCommandKeys = new Set<string>();
let dynamicPluginCompletionPaths: readonly (readonly string[])[] = Object.freeze([]);
/**
 * The last synchronized plugin command sources. Completion derives one command's
 * invocation options from its canonical contributed Action definition on demand,
 * so a cold dispatch never pays for compiling every plugin command's fields.
 */
let dynamicPluginCommandSources: Readonly<{
  registry: ResolvedContributionRegistry;
  projection: PluginCommandProjection;
}> | null = null;

const PLUGIN_COMMAND_COMPATIBILITY_OPTIONS: readonly string[] = Object.freeze(['--help', '--input', '--json']);

async function readPluginCommandCompletionCandidates(
  committed: readonly string[],
  prefix: string,
  resolveDynamicOptions?: import('@/cli/actions/commandCompletion').ActionCliDynamicOptionsResolver,
): Promise<readonly string[]> {
  const sources = dynamicPluginCommandSources;
  if (!sources) return Object.freeze([]);
  const completion = await import('@/cli/pluginCommandFields');
  const params = {
    registry: sources.registry,
    projection: sources.projection,
    committed,
    prefix,
    fallback: PLUGIN_COMMAND_COMPATIBILITY_OPTIONS,
  };
  if (!resolveDynamicOptions) return completion.resolvePluginCommandCompletionCandidates(params);
  try {
    return await completion.resolvePluginCommandCompletionCandidatesWithDynamicOptions({
      ...params,
      resolveDynamicOptions,
    });
  } catch {
    return completion.resolvePluginCommandCompletionCandidates(params);
  }
}
let dynamicPluginCommandTmuxEntries: readonly Readonly<{
  path: readonly string[];
  mode: 'inherit' | 'required' | 'forbidden';
  available: boolean;
}>[] = Object.freeze([]);
let mergedAgentCommandRegistryPromise: Promise<void> | null = null;

export function listRegisteredCommandSurfaceEntries(): readonly CommandSurfaceDescriptorInput[] {
  return Object.freeze([
    {
      command: null,
      rootHelpLabel: 'happier [options]',
      rootHelpDescription: 'Start the default backend with mobile control',
      allowTmux: true,
    },
    ...Object.values(mutableCommandSurfaceEntries),
  ]);
}

export function isStaticCommandSurfaceReserved(command: string): boolean {
  return Object.prototype.hasOwnProperty.call(staticCommandRegistryEntries, command);
}

export function isStaticCommandSurfaceProviderPlaceholder(command: string): boolean {
  const entry = staticCommandRegistryEntries[command];
  return Boolean(entry && !entry.handler
    && typeof entry.surface.rootHelpLabel === 'string'
    && typeof entry.surface.rootHelpDescription === 'string');
}

function syncAgentCommandRegistryFromCatalogSnapshot(registry: ResolvedContributionRegistry): void {
  for (const key of dynamicAgentCommandKeys) {
    delete mutableCommandRegistry[key];
    delete mutableCommandPolicies[key];
    delete mutableCommandSurfaceEntries[key];
  }
  dynamicAgentCommandKeys.clear();

  const agentEntries = Object.values(registry.catalogEntriesById)
    .filter((entry) => Boolean(entry.getCliCommandHandler));
  const collidingAgentRoots = new Set(listCollidingAgentCommandRoots(agentEntries));

  for (const entry of agentEntries) {
    if (!entry.getCliCommandHandler) continue;
    if (
      collidingAgentRoots.has(entry.cliSubcommand) ||
      Object.prototype.hasOwnProperty.call(staticCommandRegistry, entry.cliSubcommand) ||
      // A root the Action catalog already owns is not a free Agent spelling.
      dynamicActionCommandKeys.has(entry.cliSubcommand) ||
      (isStaticCommandSurfaceReserved(entry.cliSubcommand)
        && !isStaticCommandSurfaceProviderPlaceholder(entry.cliSubcommand))
    ) {
      continue;
    }
    mutableCommandRegistry[entry.cliSubcommand] = async (context) => {
      const handler = await entry.getCliCommandHandler!();
      await handler(context);
    };
    if (entry.cliCommandPolicy) {
      mutableCommandPolicies[entry.cliSubcommand] = entry.cliCommandPolicy;
    } else {
      delete mutableCommandPolicies[entry.cliSubcommand];
    }
    const title = registry.agentDefinitionsById.get(entry.id)?.runtimeSpec?.title?.trim()
      || entry.cliSubcommand;
    mutableCommandSurfaceEntries[entry.cliSubcommand] = {
      command: entry.cliSubcommand,
      rootHelpLabel: entry.rootHelpLabel ?? `happier ${entry.cliSubcommand}`,
      rootHelpDescription: entry.rootHelpDescription ?? `Start ${title}`,
      ...(entry.rootHelpDetail ? { rootHelpDetail: entry.rootHelpDetail } : {}),
      allowTmux: entry.allowTmux ?? true,
    };
    dynamicAgentCommandKeys.add(entry.cliSubcommand);
  }
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

export function synchronizePluginCommandContributions(registry: ResolvedContributionRegistry): void {
  for (const key of dynamicPluginCommandKeys) {
    delete mutableCommandRegistry[key];
    delete mutableCommandPolicies[key];
    delete mutableCommandSurfaceEntries[key];
  }
  dynamicPluginCommandKeys.clear();

  const reservedRoots = new Set<string>([
    ...Object.keys(staticCommandRegistry),
    ...dynamicAgentCommandKeys,
    // A root the Action catalog owns is reserved for the same reason a static
    // root is: one admitted owner per path, decided here rather than at dispatch.
    ...dynamicActionCommandKeys,
  ]);
  for (const command of registry.commands ?? []) {
    const root = command.definition.path[0];
    if (root && isStaticCommandSurfaceReserved(root)) reservedRoots.add(root);
  }
  const projection = resolvePluginCommandProjection({ registry, reservedRoots });
  dynamicPluginCompletionPaths = Object.freeze(projection.commands
    .filter((command) => command.status === 'available')
    .map((command) => Object.freeze([...command.path])));
  dynamicPluginCommandTmuxEntries = Object.freeze((registry.commands ?? [])
    .map((command) => {
      const path = Object.freeze([...command.definition.path]);
      const projected = projection.commands.find((candidate) => (
        candidate.qualifiedId === `${command.pluginId}/${command.definition.id}`
        && candidate.path.length === path.length
        && candidate.path.every((segment, index) => segment === path[index])
      ));
      return Object.freeze({
        path,
        mode: command.definition.tmux ?? 'inherit',
        available: projected?.status === 'available',
      });
    }));
  dynamicPluginCommandSources = Object.freeze({ registry, projection });
  // Plugin roots changed, so the admitted Action set has to be recomputed
  // against the current reservations rather than reused.
  admittedActionCliCommandsCache = null;

  for (const root of projection.roots) {
    mutableCommandRegistry[root] = lazyPluginCommandHandler(root);
    mutableCommandPolicies[root] = undefined;
    const rootHelpEntry = projection.rootHelpEntries.find((entry) => entry.command === root);
    mutableCommandSurfaceEntries[root] = rootHelpEntry ?? { command: root, allowTmux: false };
    dynamicPluginCommandKeys.add(root);
  }
}

const dynamicActionCommandKeys = new Set<string>();
let admittedActionCliCommandsCache: readonly CompiledActionCliCommand[] | null = null;

/**
 * The compiled Action command paths this registry admits, plus the root entries
 * they need.
 *
 * There is no second path map: Action paths, plugin paths and static roots are
 * resolved by the same collision rules here. An Agent or plugin root owns its
 * whole subtree, so a declared Action path underneath one is not admitted; every
 * other declared path is admitted, and a leaf under an existing static root wins
 * only for its exact spelling while the root handler keeps everything else.
 */
let actionCliRootsRegistered = false;

/**
 * Claims the roots the Action catalog owns. This runs before Agent and plugin
 * synchronization so those sources see the Action roots as reserved, and it
 * reads only the declared paths — compiling every command's fields is deferred
 * to the first invocation or completion that actually needs them.
 */
async function ensureActionCliRootsRegistered(): Promise<void> {
  if (actionCliRootsRegistered) return;
  const { listActionCliCommandDeclarations } = await import('@happier-dev/protocol/actions/actionSpecs');
  for (const { binding } of listActionCliCommandDeclarations()) {
    const root = binding.path[0];
    if (root === undefined) continue;
    dynamicActionCommandKeys.add(root);
    if (Object.prototype.hasOwnProperty.call(mutableCommandRegistry, root)) continue;
    mutableCommandRegistry[root] = lazyActionCliRootHandler(root);
    const rootHelp = ACTION_CLI_ROOT_HELP[root];
    mutableCommandSurfaceEntries[root] = {
      command: root,
      ...(rootHelp ? { rootHelpLabel: rootHelp.label, rootHelpDescription: rootHelp.description } : {}),
      allowTmux: false,
    };
  }
  actionCliRootsRegistered = true;
}

async function loadAdmittedActionCliCommands(): Promise<readonly CompiledActionCliCommand[]> {
  if (admittedActionCliCommandsCache) return admittedActionCliCommandsCache;
  await ensureActionCliRootsRegistered();
  const { listCompiledActionCliCommands } = await import('@/cli/actions/compiledCommands');
  const compiledCommands = listCompiledActionCliCommands();
  assertActionCommandPathsFitStaticRegistry(compiledCommands);
  admittedActionCliCommandsCache = Object.freeze(compiledCommands.filter((command) => {
    const root = command.path[0];
    return !dynamicAgentCommandKeys.has(root) && !dynamicPluginCommandKeys.has(root);
  }));
  return admittedActionCliCommandsCache;
}

/** Command-path words, stopping at the first option token. */
function readLeadingCommandWords(args: readonly string[]): readonly string[] {
  const words: string[] = [];
  for (const token of args) {
    if (token.startsWith('-')) break;
    words.push(token);
  }
  return words;
}

/**
 * The compiled Action command this argv names, or `null` when a dedicated
 * command owns the path. Dispatch consults this before the root handler so a
 * migrated leaf reaches its canonical Action, while every unmigrated spelling
 * still falls through to its existing owner.
 */
export async function resolveAdmittedActionCliCommand(
  args: readonly string[],
): Promise<CompiledActionCliCommand | null> {
  const words = readLeadingCommandWords(args);
  if (words.length === 0) return null;
  const { findCompiledActionCliCommand } = await import('@/cli/actions/compiledCommands');
  return findCompiledActionCliCommand(words, await loadAdmittedActionCliCommands());
}

export async function resolveCommandCompletionCandidates(
  words: readonly string[],
  options: Readonly<{
    resolveDynamicOptions?: import('@/cli/actions/commandCompletion').ActionCliDynamicOptionsResolver;
    resolveDynamicActionDefinition?: (
      actionId: string,
      argv: readonly string[],
    ) => Promise<ActionDefinitionV1 | null>;
  }> = {},
): Promise<readonly string[]> {
  const prefix = words.at(-1) ?? '';
  const committed = words.length > 0 ? words.slice(0, -1) : [];
  const candidates = new Set<string>();
  const actionCommands = await loadAdmittedActionCliCommands();
  const allPaths: readonly (readonly string[])[] = [
    ...Object.keys(mutableCommandRegistry).map((command) => [command] as const),
    ...dynamicPluginCompletionPaths,
  ];
  for (const path of allPaths) {
    if (!committed.every((segment, index) => path[index] === segment)) continue;
    const next = path[committed.length];
    if (next?.startsWith(prefix)) candidates.add(next);
  }
  const completion = await import('@/cli/actions/commandCompletion');

  // `actions invoke` is intentionally a dynamic generic workflow, not a
  // friendly command path. Once its exact Action id is known, completion uses
  // the same published definition and field compiler as execution rather than
  // introducing a second command registry or a plugin-only flag grammar.
  if (
    options.resolveDynamicActionDefinition
    && committed[0] === 'actions'
    && committed[1] === 'invoke'
    && typeof committed[2] === 'string'
  ) {
    try {
      const definition = await options.resolveDynamicActionDefinition(committed[2], committed);
      if (definition) {
        const { compileActionCliFieldsFromJsonSchema } = await import('@/cli/actions/compiledCommands');
        const target = {
          fields: compileActionCliFieldsFromJsonSchema({
            jsonSchema: definition.inputSchema,
            hints: definition.inputHints ?? undefined,
            reservedFlags: ['--machine-id', '--request-id', '--server-id'],
          }),
          positionals: Object.freeze([]),
        };
        const inputWords = committed.slice(3);
        const invokeCandidates = options.resolveDynamicOptions
          ? await completion.resolveActionCliInputCompletionCandidatesWithDynamicOptions({
              target,
              actionId: definition.id,
              committed: inputWords,
              prefix,
              resolveDynamicOptions: options.resolveDynamicOptions,
              cliOwnedFlags: {
                valueFlags: ['--server-id', '--machine-id', '--request-id'],
              },
            })
          : completion.resolveActionCliInputCompletionCandidates({
              target,
              committed: inputWords,
              prefix,
            });
        for (const candidate of invokeCandidates) candidates.add(candidate);
        if (!inputWords.includes('--')) {
          for (const flag of ['--server-id', '--machine-id', '--request-id']) {
            if (prefix === '' || flag.startsWith(prefix)) candidates.add(flag);
          }
        }
      }
    } catch {
      // Completion is advisory. Discovery/authentication/connectivity failures
      // retain static candidates and never reinterpret availability.
    }
  }
  const staticActionCandidates = completion.resolveCompiledActionCliCompletionCandidates({
    committed,
    prefix,
    commands: actionCommands,
  });
  for (const candidate of staticActionCandidates) {
    candidates.add(candidate);
  }
  if (options.resolveDynamicOptions) {
    try {
      for (const candidate of await completion.resolveCompiledActionCliCompletionCandidatesWithDynamicOptions({
        committed,
        prefix,
        commands: actionCommands,
        resolveDynamicOptions: options.resolveDynamicOptions,
      })) {
        candidates.add(candidate);
      }
    } catch {
      // Completion is advisory. Authentication, connectivity, and option-source
      // failures retain the compiler's static candidates rather than breaking
      // the user's shell or inventing a local options registry.
    }
  }
  for (const candidate of await readPluginCommandCompletionCandidates(
    committed,
    prefix,
    options.resolveDynamicOptions,
  )) {
    candidates.add(candidate);
  }
  return Object.freeze([...candidates].sort());
}

export function resolvePluginCommandTmuxMode(args: readonly string[]): 'inherit' | 'required' | 'forbidden' | null {
  const path: string[] = [];
  for (const token of args) {
    // Plugin command declarations own a fixed path and expose Action input as
    // options. Once options begin, their values cannot become command words.
    if (token.startsWith('-')) break;
    path.push(token);
  }
  const exact = dynamicPluginCommandTmuxEntries.filter((entry) => (
    entry.path.length === path.length
    && entry.path.every((segment, index) => path[index] === segment)
  ));
  if (exact.length === 0) return null;
  if (exact.length !== 1 || !exact[0]!.available) return 'forbidden';
  return exact[0]!.mode;
}

export const commandRegistry: Readonly<Record<string, CommandHandler>> = mutableCommandRegistry;

export function findCommandDispatchDescriptor(command: string): CommandDispatchDescriptor | null {
  const handler = mutableCommandRegistry[command];
  if (!handler) return null;
  const policy = mutableCommandPolicies[command];
  return Object.freeze({
    id: command,
    command,
    handler,
    ...(policy ? { policy } : {}),
  });
}

export function resolveCommandDispatchRegistry(): CommandDispatchRegistry {
  return createCommandDispatchRegistry(
    Object.keys(mutableCommandRegistry).map((command) => findCommandDispatchDescriptor(command)!),
  );
}

export async function ensureMergedAgentCommandRegistryLoaded(): Promise<void> {
  if (mergedAgentCommandRegistryPromise) {
    return await mergedAgentCommandRegistryPromise;
  }
  const pending = (async () => {
    const { configuration } = await import('@/configuration');
    const { resolveMergedContributionRegistry } = await import('@/plugins/projection/registry/createResolvedContributionRegistry');
    // Explicit ephemeral merged snapshot for the standalone CLI command
    // surface: it feeds only this command registry and is never written back
    // into any shared registry authority.
    const registry = await resolveMergedContributionRegistry({ happyHomeDir: configuration.happyHomeDir });
    // Some command-registry harnesses intentionally replace only the Agent catalog boundary.
    // Production always resolves the merged snapshot; absent snapshots cannot admit plugin roots.
    // Action-owned roots are claimed first so Agent and plugin synchronization
    // both see one complete reservation set, then the compiled command list is
    // resolved against the roots those sources actually took.
    await ensureActionCliRootsRegistered();
    if (registry) {
      syncAgentCommandRegistryFromCatalogSnapshot(registry);
      synchronizePluginCommandContributions(registry);
    }
    await loadAdmittedActionCliCommands();
  })();
  mergedAgentCommandRegistryPromise = pending;
  try {
    await pending;
  } finally {
    if (mergedAgentCommandRegistryPromise === pending) {
      mergedAgentCommandRegistryPromise = null;
    }
  }
}
