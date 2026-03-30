import chalk from 'chalk';

import { readOptionalFlagValue } from '@/cli/sessionStartArgs';
import { runBackendSessionCliCommand } from '@/cli/runBackendSessionCliCommand';

import type { CommandContext } from '@/cli/commandRegistry';

export async function handleOpenCodeCliCommand(context: CommandContext): Promise<void> {
  await runBackendSessionCliCommand({
    context,
    loadRun: async () => (await import('@/backends/opencode/runOpenCode')).runOpenCode,
    agentIdForDeprecatedAliases: 'opencode',
    agentIdForAccountSettings: 'opencode',
    resolveExtraOptions: (args) => {
      const startingModeRaw = readOptionalFlagValue(args, '--happy-starting-mode');
      const startingMode: 'local' | 'remote' | undefined =
        startingModeRaw === 'local' || startingModeRaw === 'remote' ? startingModeRaw : undefined;
      if (startingModeRaw && !startingMode) {
        console.error(chalk.red(`Invalid --happy-starting-mode: ${startingModeRaw}. Use "local" or "remote".`));
        process.exit(1);
      }
      return { startingMode };
    },
  });
}
