import {
  createCommandSurfaceCatalog,
  type CommandSurfaceCatalog,
  type CommandSurfaceDescriptorInput,
} from '@/agent/runtime/registry/commandContracts';
import { getResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';

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
    command: 'providers',
    rootHelpLabel: 'happier providers',
    rootHelpDescription: 'Install and manage provider CLIs',
    allowTmux: false,
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
    rootHelpDescription: 'Install provider CLIs and helpers',
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
  {
    command: 'sessions',
    allowTmux: false,
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
  const registry = getResolvedContributionRegistry();
  const entries: CliCommandSurfaceEntry[] = [];

  for (const provider of registry.providerDefinitionsById.values()) {
    const catalogEntry = registry.catalogEntriesById[provider.id];
    if (!catalogEntry?.getCliCommandHandler) {
      continue;
    }

    const command = catalogEntry.cliSubcommand;
    if (!command) {
      continue;
    }

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

export function resolveCommandSurfaceCatalog(): CommandSurfaceCatalog {
  return createCommandSurfaceCatalog(mergeCommandSurfaceEntries([
    ...COMMAND_SURFACE_MANIFEST,
    ...readProjectedProviderRootHelpEntries(),
  ]));
}
