import {
  createCommandSurfaceCatalog,
  type CommandSurfaceCatalog,
  type CommandSurfaceDescriptor,
  type CommandSurfaceDescriptorInput,
} from '@/agent/runtime/registry/commandContracts';
import type { ResolvedContributionRegistry } from '@/plugins/projection/registry/types';
import { SESSION_HELP_LINES } from '@/cli/commands/session/shared/sessionCommandUsage';
import { FIRST_CLASS_SESSION_COMMANDS } from '@/cli/firstClassSessionCommands';

export type CliCommandSurfaceEntry = CommandSurfaceDescriptorInput;

const COMMAND_SURFACE_MANIFEST: readonly CliCommandSurfaceEntry[] = [
  {
    command: null,
    rootHelpLabel: 'happier [options]',
    rootHelpDescription: 'Start the default backend with mobile control',
    allowTmux: true,
  },
  {
    command: 'setup',
    rootHelpLabel: 'happier setup',
    rootHelpDescription: 'Guided setup for this computer',
    allowTmux: false,
  },
  {
    command: 'auth',
    rootHelpLabel: 'happier auth',
    rootHelpDescription: 'Manage authentication',
    allowTmux: false,
  },
  {
    command: 'automation',
    rootHelpLabel: 'happier automation',
    rootHelpDescription: 'Trigger and manage automations',
    allowTmux: false,
  },
  {
    command: 'mcp',
    rootHelpLabel: 'happier mcp',
    rootHelpDescription: 'Expose the MCP server and manage MCP clients',
    allowTmux: false,
  },
  {
    command: 'codex',
    rootHelpLabel: 'happier codex',
    rootHelpDescription: 'Start Codex mode',
    allowTmux: true,
  },
  {
    command: 'gemini',
    rootHelpLabel: 'happier gemini',
    rootHelpDescription: 'Start Gemini mode (ACP)',
    allowTmux: true,
  },
  {
    command: 'connect',
    rootHelpLabel: 'happier connect',
    rootHelpDescription: 'Connect AI vendor API keys',
    allowTmux: false,
  },
  {
    command: 'completion',
    rootHelpLabel: 'happier completion',
    rootHelpDescription: 'Generate shell completion or list completion candidates',
    allowTmux: false,
  },
  {
    command: 'agents',
    rootHelpLabel: 'happier agents',
    rootHelpDescription: 'Install and manage agent CLIs',
    allowTmux: false,
  },
  {
    command: 'agent',
    allowTmux: false,
    // Deprecated 2026-08-22 (D11); removal is intentionally unscheduled.
  },
  {
    command: 'providers',
    rootHelpLabel: 'happier providers',
    rootHelpDescription: 'Configure model providers and connections',
    allowTmux: false,
  },
  {
    command: 'provider',
    allowTmux: false,
    // Deprecated 2026-08-22 (D11); removal is intentionally unscheduled.
  },
  {
    command: 'plugins',
    rootHelpLabel: 'happier plugins',
    rootHelpDescription: 'Discover and manage plugins',
    allowTmux: false,
  },
  {
    command: 'notify',
    rootHelpLabel: 'happier notify',
    rootHelpDescription: 'Send push notification',
    allowTmux: false,
  },
  {
    command: 'install',
    rootHelpLabel: 'happier install',
    rootHelpDescription: 'Install agent CLIs and helpers',
    allowTmux: false,
  },
  {
    command: 'status',
    rootHelpLabel: 'happier status',
    rootHelpDescription: 'Show system status and recommended repairs',
    allowTmux: false,
  },
  {
    command: 'service',
    rootHelpLabel: 'happier service',
    rootHelpDescription: 'Manage the background service that allows',
    rootHelpDetail: 'to spawn new sessions away from your computer',
    allowTmux: false,
  },
  {
    command: 'daemon',
    allowTmux: false,
  },
  {
    command: 'doctor',
    rootHelpLabel: 'happier doctor',
    rootHelpDescription: 'System diagnostics & troubleshooting',
    allowTmux: false,
  },
  {
    command: 'uninstall',
    rootHelpLabel: 'happier uninstall',
    rootHelpDescription: 'Uninstall the current managed Happier CLI',
    allowTmux: false,
  },
  {
    command: 'self',
    rootHelpLabel: 'happier self',
    rootHelpDescription: 'Manage CLI updates and release channels',
    allowTmux: false,
  },
  {
    command: 'self-update',
    rootHelpLabel: 'happier self-update',
    rootHelpDescription: 'Update the Happier CLI',
    allowTmux: false,
  },
  {
    command: 'session',
    rootHelpLabel: 'happier session',
    rootHelpDescription: 'Manage sessions and execution runs',
    allowTmux: false,
  },
  ...FIRST_CLASS_SESSION_COMMANDS.flatMap((sessionCommand) => [
    {
      command: sessionCommand.command,
      rootHelpLabel: sessionCommand.rootHelpLabel,
      rootHelpDescription: sessionCommand.rootHelpDescription,
      allowTmux: false,
    },
    ...(sessionCommand.aliases ?? []).map((alias) => ({ command: alias, allowTmux: false })),
  ]),
  {
    command: 'resume',
    rootHelpLabel: SESSION_HELP_LINES.resume,
    rootHelpDescription: 'Resume an inactive session',
    allowTmux: true,
  },
  {
    // Compatibility alias: intentionally accepted but omitted from root help.
    command: 'sessions',
    allowTmux: false,
    // Deprecated 2026-08-22 (D11); removal is intentionally unscheduled.
  },
  {
    // Compatibility alias: intentionally accepted but omitted from root help.
    command: 'automations',
    allowTmux: false,
    // Deprecated 2026-08-22 (D11); removal is intentionally unscheduled.
  },
  {
    command: 'logout',
    allowTmux: false,
  },
  {
    command: 'attach',
    allowTmux: false,
  },
  {
    command: 'server',
    allowTmux: false,
  },
];

function readProjectedProviderRootHelpEntries(): readonly CliCommandSurfaceEntry[] {
  const entries: CliCommandSurfaceEntry[] = [];

  for (const provider of projectedProviderRegistry?.agentDefinitionsById.values() ?? []) {
    const catalogEntry = projectedProviderRegistry?.catalogEntriesById[provider.id];
    if (!catalogEntry?.getCliCommandHandler) continue;

    const command = catalogEntry.cliSubcommand;
    if (!command) continue;

    const title = provider.runtimeSpec?.title?.trim() || command;
    entries.push({
      command,
      rootHelpLabel: catalogEntry.rootHelpLabel ?? `happier ${command}`,
      rootHelpDescription: catalogEntry.rootHelpDescription ?? `Start ${title}`,
      ...(catalogEntry.rootHelpDetail ? { rootHelpDetail: catalogEntry.rootHelpDetail } : {}),
      allowTmux: catalogEntry.allowTmux ?? true,
    });
  }

  return entries;
}

let projectedProviderRegistry: Pick<ResolvedContributionRegistry, 'agentDefinitionsById' | 'catalogEntriesById'> | null = null;
let projectedPluginCommandRootHelpEntries: readonly CliCommandSurfaceEntry[] = Object.freeze([]);

export function setProjectedPluginCommandRootHelpEntries(entries: readonly CliCommandSurfaceEntry[]): void {
  projectedPluginCommandRootHelpEntries = entries;
}

export async function primeProjectedCommandSurfaceEntries(): Promise<void> {
  const { getResolvedContributionRegistry } = await import('@/plugins/projection/registry/createResolvedContributionRegistry');
  projectedProviderRegistry = getResolvedContributionRegistry();
}

function mergeCommandSurfaceEntries(
  entries: readonly CliCommandSurfaceEntry[],
): readonly CliCommandSurfaceEntry[] {
  const entriesByCommand = new Map<string | null, CliCommandSurfaceEntry>();
  const orderedCommands: Array<string | null> = [];

  for (const entry of entries) {
    const command = entry.command ?? null;
    if (!entriesByCommand.has(command)) {
      orderedCommands.push(command);
    }
    entriesByCommand.set(command, entry);
  }

  return orderedCommands.map((command) => entriesByCommand.get(command)!);
}

export function listRootHelpCommands(): readonly CliCommandSurfaceEntry[] {
  return resolveCommandSurfaceCatalog().commands.filter((entry) => typeof entry.rootHelpLabel === 'string');
}

export function isTmuxAllowedCommand(command: string | null | undefined): boolean {
  if (!command) return true;
  const entry = resolveCommandSurfaceCatalog().commands.find((candidate) => candidate.command === command);
  return entry ? entry.allowTmux : true;
}

export function findCommandSurfaceEntry(command: string): CommandSurfaceDescriptor | null {
  return resolveCommandSurfaceCatalog().findByCommand(command);
}

export function isStaticCommandSurfaceReserved(command: string): boolean {
  return COMMAND_SURFACE_MANIFEST.some((entry) => entry.command === command);
}

export function isStaticCommandSurfaceProviderPlaceholder(command: string): boolean {
  const entry = COMMAND_SURFACE_MANIFEST.find((candidate) => candidate.command === command);
  if (!entry) return false;
  return typeof entry.rootHelpLabel === 'string'
    && typeof entry.rootHelpDescription === 'string';
}

export function resolveCommandSurfaceCatalog(): CommandSurfaceCatalog {
  return createCommandSurfaceCatalog(mergeCommandSurfaceEntries([
    ...COMMAND_SURFACE_MANIFEST,
    ...readProjectedProviderRootHelpEntries(),
    ...projectedPluginCommandRootHelpEntries,
  ]));
}
