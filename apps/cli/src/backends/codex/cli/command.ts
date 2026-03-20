import chalk from 'chalk';

import { readOptionalFlagValue, readOptionalFlagValueFromAliases } from '@/cli/sessionStartArgs';
import { runBackendSessionCliCommand } from '@/cli/runBackendSessionCliCommand';

import type { CommandContext } from '@/cli/commandRegistry';

export async function handleCodexCliCommand(context: CommandContext): Promise<void> {
  await runBackendSessionCliCommand({
    context,
    loadRun: async () => (await import('@/backends/codex/runCodex')).runCodex,
    agentIdForAccountSettings: 'codex',
    resolveExtraOptions: (args) => {
      const startingModeRaw = readOptionalFlagValue(args, '--happy-starting-mode');
      const startingMode: 'local' | 'remote' | undefined =
        startingModeRaw === 'local' || startingModeRaw === 'remote' ? startingModeRaw : undefined;
      const directoryRaw = readOptionalFlagValueFromAliases(args, ['-C', '--cd']);
      const directory = typeof directoryRaw === 'string' && directoryRaw.trim().length > 0
        ? directoryRaw.trim()
        : undefined;
      if (startingModeRaw && !startingMode) {
        console.error(chalk.red(`Invalid --happy-starting-mode: ${startingModeRaw}. Use "local" or "remote".`));
        process.exit(1);
      }
      return { startingMode, directory };
    },
  });
}
