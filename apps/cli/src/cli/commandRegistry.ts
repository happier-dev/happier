import type { TerminalRuntimeFlags } from '@/terminal/runtime/terminalRuntimeFlags';

import { AGENTS, type AgentCatalogEntry } from '@/backends/catalog';

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
import { handleProfilesCliCommand } from './commands/profiles';
import { handlePluginsCompatibilityCliCommand } from './commands/pluginsCompatibility';
import { handleRelayCliCommand } from './commands/relay';
import { handleResumeCliCommand } from './commands/resume';
import { handleSessionCliCommand } from './commands/session/index';
import { handleServerCliCommand } from './commands/server';
import { handleServiceCliCommand } from './commands/service';
import { handleSelfCliCommand } from './commands/self';
import { handleSelfUpdateCliCommand } from './commands/selfUpdate';
import { handleStatusCliCommand } from './commands/status';
import { handleToolsCliCommand } from './commands/tools';
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
  capabilities: handleCapabilitiesCliCommand,
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
  plugins: handlePluginsCompatibilityCliCommand,
  profile: handleProfilesCliCommand,
  profiles: handleProfilesCliCommand,
  relay: handleRelayCliCommand,
  resume: handleResumeCliCommand,
  service: handleServiceCliCommand,
  session: handleSessionCliCommand,
  // Backwards-compatible plural alias; keep the singular command canonical in help.
  sessions: handleSessionCliCommand,
  server: handleServerCliCommand,
  self: handleSelfCliCommand,
  'self-update': handleSelfUpdateCliCommand,
  status: handleStatusCliCommand,
  tools: handleToolsCliCommand,
  ...buildAgentCommandRegistry(),
};
