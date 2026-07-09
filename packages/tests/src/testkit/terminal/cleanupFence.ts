const TERMINAL_FENCE_PATHS = [
  'apps/cli/src/daemon',
  'apps/cli/src/api/machine/rpcHandlers.terminal.ts',
  'apps/ui/sources/hooks/machine/useMachineTerminalSession.ts',
  'apps/ui/sources/components/sessions/terminal',
  'apps/ui/sources/components/terminal',
  'apps/ui/sources/sync/ops/machineTerminal.ts',
  'packages/protocol/src/daemon/terminal.ts',
  'packages/protocol/src/terminal',
] as const;

const PLUGIN_FENCE_PATHS = [
  'apps/cli/src/plugins',
  'apps/ui/sources/agents',
  'packages/plugin-sdk',
  'packages/plugins',
  'packages/protocol/src/plugins',
] as const;

const SOURCE_ONLY_RG_FLAGS = [
  "--glob '!**/*.test.*'",
  "--glob '!**/*.spec.*'",
  "--glob '!**/__tests__/**'",
  "--glob '!**/*.generated.*'",
] as const;

export function buildTerminalCleanupFenceCommands(): readonly string[] {
  const terminalPaths = TERMINAL_FENCE_PATHS.join(' ');
  const pluginPaths = PLUGIN_FENCE_PATHS.join(' ');
  const sourceOnlyFlags = SOURCE_ONLY_RG_FLAGS.join(' ');
  return [
    `rg -n ${sourceOnlyFlags} "terminalPty" ${terminalPaths}`,
    `rg -n ${sourceOnlyFlags} "DaemonTerminalStreamEventDataSchema|onData\\\\(listener: \\\\(data: string\\\\)|write\\\\(data: string\\\\)|legacy.*data: string" ${terminalPaths}`,
    `rg -n ${sourceOnlyFlags} "\\bctx\\\\.terminal\\\\b|terminal[._-]?byte[._-]?stream|\\bTerminalStreamFrame\\b" ${pluginPaths}`,
  ];
}
