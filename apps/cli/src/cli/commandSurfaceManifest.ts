import {
  createCommandSurfaceCatalog,
  type CommandSurfaceCatalog,
  type CommandSurfaceDescriptor,
  type CommandSurfaceDescriptorInput,
} from '@/agent/runtime/registry/commandContracts';
import {
  isStaticCommandSurfaceProviderPlaceholder,
  isStaticCommandSurfaceReserved,
  listRegisteredCommandSurfaceEntries,
} from '@/cli/commandRegistry';

export type CliCommandSurfaceEntry = CommandSurfaceDescriptorInput;

export function listRootHelpCommands(): readonly CliCommandSurfaceEntry[] {
  return resolveCommandSurfaceCatalog().commands.filter((entry) => typeof entry.rootHelpLabel === 'string');
}

export function isTmuxAllowedCommand(command: string | null | undefined): boolean {
  if (!command) return true;
  const entry = resolveCommandSurfaceCatalog().findByCommand(command);
  return entry ? entry.allowTmux : true;
}

export function findCommandSurfaceEntry(command: string): CommandSurfaceDescriptor | null {
  return resolveCommandSurfaceCatalog().findByCommand(command);
}

export { isStaticCommandSurfaceProviderPlaceholder, isStaticCommandSurfaceReserved };

export function resolveCommandSurfaceCatalog(): CommandSurfaceCatalog {
  return createCommandSurfaceCatalog(listRegisteredCommandSurfaceEntries());
}
