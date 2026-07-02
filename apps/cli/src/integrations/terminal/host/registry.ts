import type { TerminalHostAdapter, TerminalHostKind } from './_types';

export type TerminalHostRegistry = Readonly<Partial<Record<TerminalHostKind, TerminalHostAdapter>>>;

export function createTerminalHostRegistry(adapters: readonly TerminalHostAdapter[]): TerminalHostRegistry {
  const registry: Partial<Record<TerminalHostKind, TerminalHostAdapter>> = {};
  for (const adapter of adapters) {
    registry[adapter.kind] = adapter;
  }
  return registry;
}
