import type { TerminalRuntimeFlags } from '@/terminal/runtime/terminalRuntimeFlags';

import { AGENTS, type AgentCatalogEntry } from '@/backends/catalog';

import { handleAttachCliCommand } from './commands/attach';
import { handleAuthCliCommand } from './commands/auth';
import { handleBugReportCliCommand } from './commands/bugReport';
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
import { handleToolsCliCommand } from './commands/tools';
import { handleUninstallCliCommand } from './commands/uninstall';
import { handleConfiguredAcpCatalogCliCommand } from '@/agent/acp/catalog/configured/handleConfiguredAcpCatalogCliCommand';

export type CommandContext = Readonly<{
  args: string[];
  rawArgv: string[];
  terminalRuntime: TerminalRuntimeFlags | null;
}>;

export type CommandHandler = (context: CommandContext) => Promise<void>;

function buildAgentCommandRegistry(): Readonly<Record<string, CommandHandler>> {
  const registry: Record<string, CommandHandler> = {};

  for (const entry of Object.values(AGENTS) as AgentCatalogEntry[]) {
    if (!entry.getCliCommandHandler) continue;
    registry[entry.cliSubcommand] = async (context) => {
      const handler = await entry.getCliCommandHandler!();
      await handler(context);
    };
  }

  return registry;
}

export const commandRegistry: Readonly<Record<string, CommandHandler>> = {
  attach: handleAttachCliCommand,
  'acp-catalog': handleConfiguredAcpCatalogCliCommand,
  auth: handleAuthCliCommand,
  'bug-report': handleBugReportCliCommand,
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
  server: handleServerCliCommand,
  self: handleSelfCliCommand,
  'self-update': handleSelfUpdateCliCommand,
  tools: handleToolsCliCommand,
  uninstall: handleUninstallCliCommand,
  ...buildAgentCommandRegistry(),
};
