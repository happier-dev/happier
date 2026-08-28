import type { TerminalRuntimeFlags } from '@/terminal/runtime/terminalRuntimeFlags';
import type {
  ConnectedServiceBindingsV1,
  SessionProviderBindingMetadataV1,
  SessionProviderBindingSecurityChangeConfirmationV1,
} from '@happier-dev/protocol';

import type { ResolvedContributionRegistry } from '@/plugins/projection/registry/types';
import { resolvePluginCommandProjection } from '@/cli/pluginCommandProjection';
import {
  createCommandDispatchRegistry,
  type CommandDispatchPolicy,
  type CommandDispatchDescriptor as RuntimeCommandDispatchDescriptor,
  type CommandDispatchRegistry as RuntimeCommandDispatchRegistry,
  type CommandSurfaceDescriptorInput,
} from '@/agent/runtime/registry/commandContracts';
import { SESSION_HELP_LINES } from '@/cli/commands/session/shared/sessionCommandUsage';
import { FIRST_CLASS_SESSION_COMMANDS } from '@/cli/firstClassSessionCommands';

export type CommandContext = Readonly<{
  args: string[];
  rawArgv: string[];
  terminalRuntime: TerminalRuntimeFlags | null;
  signal?: AbortSignal;
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
    connectedServices?: ConnectedServiceBindingsV1 | null;
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
const handleActionsCliCommand = lazyCommandHandler(async () => (await import('./commands/actions')).handleActionsCliCommand);
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
  setup: { handler: handleSetupCliCommand, surface: { rootHelpLabel: 'happier setup', rootHelpDescription: 'Guided setup for this computer', allowTmux: false } },
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
  notify: { handler: handleNotifyCliCommand, surface: { rootHelpLabel: 'happier notify', rootHelpDescription: 'Send push notification', allowTmux: false } },
  install: { handler: handleInstallCliCommand, surface: { rootHelpLabel: 'happier install', rootHelpDescription: 'Install agent CLIs and helpers', allowTmux: false } },
  status: { handler: handleStatusCliCommand, surface: { rootHelpLabel: 'happier status', rootHelpDescription: 'Show system status and recommended repairs', allowTmux: false } },
  service: { handler: handleServiceCliCommand, surface: { rootHelpLabel: 'happier service', rootHelpDescription: 'Manage the background service that allows', rootHelpDetail: 'to spawn new sessions away from your computer', allowTmux: false } },
  daemon: { handler: handleDaemonCliCommand, surface: { rootHelpLabel: 'happier daemon', rootHelpDescription: 'Manage daemon status and sessions', allowTmux: false } },
  machine: { handler: handleMachineCliCommand, surface: { rootHelpLabel: 'happier machine', rootHelpDescription: 'Set up remote machines over SSH', allowTmux: false } },
  machines: { handler: handleMachinesCliCommand, surface: { rootHelpLabel: 'happier machines', rootHelpDescription: 'Discover Account machines for API targeting', allowTmux: false } },
  actions: { handler: handleActionsCliCommand, surface: { rootHelpLabel: 'happier actions', rootHelpDescription: 'Discover and invoke built-in and contributed Actions', allowTmux: false } },
  relay: { handler: handleRelayCliCommand, surface: { rootHelpLabel: 'happier relay', rootHelpDescription: 'Configure relay access and local runtimes', allowTmux: false } },
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
const dynamicPluginCommandKeys = new Set<string>();
let dynamicPluginCompletionPaths: readonly (readonly string[])[] = Object.freeze([]);
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

  for (const entry of Object.values(registry.catalogEntriesById)) {
    if (!entry.getCliCommandHandler) continue;
    if (
      Object.prototype.hasOwnProperty.call(staticCommandRegistry, entry.cliSubcommand) ||
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
  ]);
  for (const command of registry.commands ?? []) {
    const root = command.definition.path[0];
    if (root && isStaticCommandSurfaceReserved(root)) reservedRoots.add(root);
  }
  const projection = resolvePluginCommandProjection({ registry, reservedRoots });
  dynamicPluginCompletionPaths = Object.freeze(projection.commands
    .filter((command) => command.status === 'available')
    .map((command) => Object.freeze([...command.path])));
  dynamicPluginCommandTmuxEntries = Object.freeze(projection.commands
    .map((command) => Object.freeze({
      path: command.path,
      mode: command.tmux,
      available: command.status === 'available',
    })));

  for (const root of projection.roots) {
    mutableCommandRegistry[root] = lazyPluginCommandHandler(root);
    mutableCommandPolicies[root] = undefined;
    const rootHelpEntry = projection.rootHelpEntries.find((entry) => entry.command === root);
    mutableCommandSurfaceEntries[root] = rootHelpEntry ?? { command: root, allowTmux: false };
    dynamicPluginCommandKeys.add(root);
  }
}

export function resolveCommandCompletionCandidates(words: readonly string[]): readonly string[] {
  const prefix = words.at(-1) ?? '';
  const committed = words.length > 0 ? words.slice(0, -1) : [];
  const candidates = new Set<string>();
  const allPaths: readonly (readonly string[])[] = [
    ...Object.keys(mutableCommandRegistry).map((command) => [command] as const),
    ...dynamicPluginCompletionPaths,
  ];
  for (const path of allPaths) {
    if (!committed.every((segment, index) => path[index] === segment)) continue;
    const next = path[committed.length];
    if (next?.startsWith(prefix)) candidates.add(next);
  }
  const exactPluginCommand = dynamicPluginCompletionPaths.some((path) => (
    path.length === committed.length
    && path.every((segment, index) => committed[index] === segment)
  ));
  if (exactPluginCommand && (prefix === '' || prefix.startsWith('-'))) {
    for (const option of ['--help', '--input', '--json']) {
      if (option.startsWith(prefix)) candidates.add(option);
    }
  }
  return Object.freeze([...candidates].sort());
}

export function resolvePluginCommandTmuxMode(args: readonly string[]): 'inherit' | 'required' | 'forbidden' | null {
  const path: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (token === '--input') {
      index += 1;
      continue;
    }
    if (token.startsWith('-')) continue;
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
    const { primeResolvedContributionRegistry } = await import('@/plugins/projection/registry/createResolvedContributionRegistry');
    const registry = await primeResolvedContributionRegistry({ happyHomeDir: configuration.happyHomeDir });
    // Some command-registry harnesses intentionally replace only the Agent catalog boundary.
    // Production priming always returns the resolved snapshot; absent snapshots cannot admit plugin roots.
    if (registry) {
      syncAgentCommandRegistryFromCatalogSnapshot(registry);
      synchronizePluginCommandContributions(registry);
    }
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
