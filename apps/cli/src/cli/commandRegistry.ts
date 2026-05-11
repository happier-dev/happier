import type { TerminalRuntimeFlags } from '@/terminal/runtime/terminalRuntimeFlags';

import { AGENTS, type AgentCatalogEntry } from '@/backends/catalog';
import {
  createCommandDispatchRegistry,
  type CommandDispatchDescriptor as RuntimeCommandDispatchDescriptor,
  type CommandDispatchRegistry as RuntimeCommandDispatchRegistry,
} from '@/agent/runtime/registry/commandContracts';
import { configuration } from '@/configuration';

import { handleAttachCliCommand } from './commands/attach';
import { handleAuthCliCommand } from './commands/auth';
import { handleBugReportCliCommand } from './commands/bugReport';
import { handleCapabilitiesCliCommand } from './commands/capabilities';
import { handleConnectCliCommand } from './commands/connect';
import { handleDaemonCliCommand } from './commands/daemon';
import { handleDoctorCliCommand } from './commands/doctor';
import { handleInstallCliCommand } from './commands/install';
import { handleLogoutCliCommand } from './commands/logout';
import { handleMachineCliCommand } from './commands/machine';
import { handleMcpCliCommand } from './commands/mcp';
import { handleNotifyCliCommand } from './commands/notify';
import { handlePluginsCliCommand } from './commands/plugins';
import { handleProfilesCliCommand } from './commands/profiles';
import { handleProvidersCliCommand } from './commands/providers';
import { handleRelayCliCommand } from './commands/relay';
import { handleResumeCliCommand } from './commands/resume';
import { handleSetupCliCommand } from './commands/setup';
import { handleSessionCliCommand } from './commands/session/index';
import { handleServerCliCommand } from './commands/server';
import { handleSelfCliCommand } from './commands/self';
import { handleSelfUpdateCliCommand } from './commands/selfUpdate';
import { handleServiceCliCommand } from './commands/service';
import { handleStatusCliCommand } from './commands/status';
import { handleToolsCliCommand } from './commands/tools';
import { handleUninstallCliCommand } from './commands/uninstall';
import { handleConfiguredAcpCatalogCliCommand } from '@/agent/acp/catalog/configured/handleCatalogCliCommand';

export type CommandContext = Readonly<{
  args: string[];
  rawArgv: string[];
  terminalRuntime: TerminalRuntimeFlags | null;
}>;

export type CommandHandler = (context: CommandContext) => Promise<void>;
export type CommandDispatchDescriptor = RuntimeCommandDispatchDescriptor<CommandHandler>;
export type CommandDispatchRegistry = RuntimeCommandDispatchRegistry<CommandHandler>;

const staticCommandRegistry: Readonly<Record<string, CommandHandler>> = {
  attach: handleAttachCliCommand,
  'acp-catalog': handleConfiguredAcpCatalogCliCommand,
  auth: handleAuthCliCommand,
  'bug-report': handleBugReportCliCommand,
  capabilities: handleCapabilitiesCliCommand,
  setup: handleSetupCliCommand,
  // Backwards-compatible alias for the MCP command namespace.
  // Prefer `happier mcp ...` in docs and help output.
  bridge: handleMcpCliCommand,
  connect: handleConnectCliCommand,
  daemon: handleDaemonCliCommand,
  doctor: handleDoctorCliCommand,
  install: handleInstallCliCommand,
  logout: handleLogoutCliCommand,
  machine: handleMachineCliCommand,
  mcp: handleMcpCliCommand,
  notify: handleNotifyCliCommand,
  profile: handleProfilesCliCommand,
  profiles: handleProfilesCliCommand,
  plugins: handlePluginsCliCommand,
  providers: handleProvidersCliCommand,
  relay: handleRelayCliCommand,
  resume: handleResumeCliCommand,
  service: handleServiceCliCommand,
  session: handleSessionCliCommand,
  sessions: handleSessionCliCommand,
  server: handleServerCliCommand,
  self: handleSelfCliCommand,
  'self-update': handleSelfUpdateCliCommand,
  status: handleStatusCliCommand,
  tools: handleToolsCliCommand,
  uninstall: handleUninstallCliCommand,
};

const mutableCommandRegistry: Record<string, CommandHandler> = {
  ...staticCommandRegistry,
};

const dynamicAgentCommandKeys = new Set<string>();
let mergedAgentCommandRegistryPromise: Promise<void> | null = null;
let mergedAgentCommandRegistryLoaded = false;

function syncAgentCommandRegistryFromCatalogSnapshot(): void {
  for (const key of dynamicAgentCommandKeys) {
    delete mutableCommandRegistry[key];
  }
  dynamicAgentCommandKeys.clear();

  for (const entry of Object.values(AGENTS) as AgentCatalogEntry[]) {
    if (!entry.getCliCommandHandler) continue;
    mutableCommandRegistry[entry.cliSubcommand] = async (context) => {
      const handler = await entry.getCliCommandHandler!();
      await handler(context);
    };
    dynamicAgentCommandKeys.add(entry.cliSubcommand);
  }
}

syncAgentCommandRegistryFromCatalogSnapshot();

export const commandRegistry: Readonly<Record<string, CommandHandler>> = mutableCommandRegistry;

export function resolveCommandDispatchRegistry(): CommandDispatchRegistry {
  return createCommandDispatchRegistry(
    Object.entries(mutableCommandRegistry).map(([command, handler]) => Object.freeze({
      id: command,
      command,
      handler,
    })),
  );
}

export async function ensureMergedAgentCommandRegistryLoaded(): Promise<void> {
  if (mergedAgentCommandRegistryLoaded) {
    return;
  }
  if (mergedAgentCommandRegistryPromise) {
    return await mergedAgentCommandRegistryPromise;
  }
  const pending = (async () => {
    const { primeResolvedContributionRegistry } = await import('@/plugins/projection/registry/createResolvedContributionRegistry');
    await primeResolvedContributionRegistry({ happyHomeDir: configuration.happyHomeDir });
    syncAgentCommandRegistryFromCatalogSnapshot();
    mergedAgentCommandRegistryLoaded = true;
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
