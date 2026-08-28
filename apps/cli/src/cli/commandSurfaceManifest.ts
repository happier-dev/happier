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

/**
 * Compatibility no-op for callers that prime root metadata alongside the live
 * command registry. Agent and plugin surfaces are now registered by that owner.
 */
export async function primeProjectedCommandSurfaceEntries(): Promise<void> {}

export function resolveCommandSurfaceCatalog(): CommandSurfaceCatalog {
  return createCommandSurfaceCatalog(listRegisteredCommandSurfaceEntries());
}
