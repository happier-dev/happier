import type { TerminalRuntimeFlags } from '@/terminal/runtime/terminalRuntimeFlags';
import type {
  ConnectedServiceBindingsV1,
  SessionProviderBindingMetadataV1,
  SessionProviderBindingSecurityChangeConfirmationV1,
} from '@happier-dev/protocol';

import type { AgentCatalogEntry } from '@/agent/catalog/types';
import type { DirectConnectedServiceEnvironmentResolver } from '@/providers/lifecycle/prepareDirectLaunch';
import type { ResolvedContributionRegistry } from '@/plugins/projection/registry/types';
import {
  handlePluginCommandCliCommand,
  resolvePluginCommandProjection,
  setProjectedPluginCommandRootHelpEntries,
} from '@/cli/pluginCommandContributions';
import {
  createCommandDispatchRegistry,
  type CommandDispatchPolicy,
  type CommandDispatchDescriptor as RuntimeCommandDispatchDescriptor,
  type CommandDispatchRegistry as RuntimeCommandDispatchRegistry,
} from '@/agent/runtime/registry/commandContracts';
import {
  isStaticCommandSurfaceProviderPlaceholder,
  isStaticCommandSurfaceReserved,
} from '@/cli/commandSurfaceManifest';

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
    resolveConnectedServiceEnvironment?: DirectConnectedServiceEnvironmentResolver;
    sessionAttachFilePath?: string;
  }>;
}>;

export type CommandHandler = (context: CommandContext) => Promise<void>;
export type CommandDispatchDescriptor = RuntimeCommandDispatchDescriptor<CommandHandler>;
export type CommandDispatchRegistry = RuntimeCommandDispatchRegistry<CommandHandler>;

type CommandRegistryEntry = Readonly<{
  handler: CommandHandler;
  policy?: CommandDispatchPolicy;
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

const staticCommandRegistryEntries: Readonly<Record<string, CommandRegistryEntry>> = {
  attach: { handler: handleAttachCliCommand },
  'acp-catalog': { handler: handleConfiguredAcpCatalogCliCommand },
  auth: { handler: handleAuthCliCommand },
  'bug-report': { handler: handleBugReportCliCommand },
  capabilities: { handler: handleCapabilitiesCliCommand },
  setup: { handler: handleSetupCliCommand },
  // Backwards-compatible alias for the MCP command namespace.
  // Prefer `happier mcp ...` in docs and help output.
  bridge: { handler: handleMcpCliCommand },
  connect: { handler: handleConnectCliCommand },
  completion: { handler: handleCompletionCliCommand },
  daemon: { handler: handleDaemonCliCommand },
  doctor: { handler: handleDoctorCliCommand },
  install: { handler: handleInstallCliCommand },
  logout: { handler: handleLogoutCliCommand },
  machine: { handler: handleMachineCliCommand },
  mcp: { handler: handleMcpCliCommand },
  notify: { handler: handleNotifyCliCommand },
  profile: { handler: handleProfilesCliCommand },
  profiles: { handler: handleProfilesCliCommand },
  plugins: { handler: handlePluginsCliCommand },
  agents: { handler: handleAgentsCliCommand },
  providers: { handler: handleProvidersCliCommand },
  relay: { handler: handleRelayCliCommand },
  resume: { handler: handleResumeCliCommand },
  service: { handler: handleServiceCliCommand },
  session: { handler: handleSessionCliCommand },
  sessions: { handler: handleSessionCliCommand },
  server: { handler: handleServerCliCommand },
  self: { handler: handleSelfCliCommand },
  'self-update': { handler: handleSelfUpdateCliCommand },
  status: { handler: handleStatusCliCommand },
  tools: { handler: handleToolsCliCommand },
  uninstall: { handler: handleUninstallCliCommand },
};

const staticCommandRegistry: Readonly<Record<string, CommandHandler>> = Object.freeze(
  Object.fromEntries(
    Object.entries(staticCommandRegistryEntries).map(([command, entry]) => [command, entry.handler]),
  ) as Record<string, CommandHandler>,
);

const mutableCommandRegistry: Record<string, CommandHandler> = { ...staticCommandRegistry };
const mutableCommandPolicies: Record<string, CommandDispatchPolicy | undefined> = Object.fromEntries(
  Object.entries(staticCommandRegistryEntries)
    .filter(([, entry]) => entry.policy)
    .map(([command, entry]) => [command, entry.policy]),
) as Record<string, CommandDispatchPolicy | undefined>;

const dynamicAgentCommandKeys = new Set<string>();
const dynamicPluginCommandKeys = new Set<string>();
let dynamicPluginCompletionPaths: readonly (readonly string[])[] = Object.freeze([]);
let dynamicPluginCommandTmuxEntries: readonly Readonly<{
  path: readonly string[];
  mode: 'inherit' | 'required' | 'forbidden';
  available: boolean;
}>[] = Object.freeze([]);
let mergedAgentCommandRegistryPromise: Promise<void> | null = null;

async function syncAgentCommandRegistryFromCatalogSnapshot(): Promise<void> {
  const { AGENTS } = await import('@/agent/catalog/registry');
  for (const key of dynamicAgentCommandKeys) {
    delete mutableCommandRegistry[key];
    delete mutableCommandPolicies[key];
  }
  dynamicAgentCommandKeys.clear();

  for (const entry of Object.values(AGENTS) as AgentCatalogEntry[]) {
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
    dynamicAgentCommandKeys.add(entry.cliSubcommand);
  }
}

export function synchronizePluginCommandContributions(registry: ResolvedContributionRegistry): void {
  for (const key of dynamicPluginCommandKeys) {
    delete mutableCommandRegistry[key];
    delete mutableCommandPolicies[key];
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
  setProjectedPluginCommandRootHelpEntries(projection.rootHelpEntries);
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
    mutableCommandRegistry[root] = async (context) => {
      await handlePluginCommandCliCommand(root, context);
    };
    mutableCommandPolicies[root] = undefined;
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
    await syncAgentCommandRegistryFromCatalogSnapshot();
    // Some command-registry harnesses intentionally replace only the Agent catalog boundary.
    // Production priming always returns the resolved snapshot; absent snapshots cannot admit plugin roots.
    if (registry) synchronizePluginCommandContributions(registry);
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
