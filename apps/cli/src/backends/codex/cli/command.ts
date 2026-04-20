import chalk from 'chalk';

import { readOptionalFlagValue, readOptionalFlagValueFromAliases } from '@/cli/sessionStartArgs';
import { runBackendSessionCliCommand } from '@/cli/runBackendSessionCliCommand';
import {
  codexRuntimeModeToHostStartingMode,
  type CodexRuntimeMode,
} from '@/backends/codex/runtime/session/types';

import type { CommandContext } from '@/cli/commandRegistry';

export async function handleCodexCliCommand(context: CommandContext): Promise<void> {
  await runBackendSessionCliCommand({
    context,
    backendIdForSessionRuntime: 'codex',
    agentIdForAccountSettings: 'codex',
    resolveExtraOptions: (args) => {
      const startingRuntimeModeRaw = readOptionalFlagValue(args, '--happy-starting-mode');
      const startingRuntimeMode: CodexRuntimeMode | undefined =
        startingRuntimeModeRaw === 'terminal' || startingRuntimeModeRaw === 'remote'
          ? startingRuntimeModeRaw
          : undefined;
      const directoryRaw = readOptionalFlagValueFromAliases(args, ['-C', '--cd']);
      const directory = typeof directoryRaw === 'string' && directoryRaw.trim().length > 0
        ? directoryRaw.trim()
        : undefined;
      if (startingRuntimeModeRaw && !startingRuntimeMode) {
        console.error(
          chalk.red(`Invalid --happy-starting-mode: ${startingRuntimeModeRaw}. Use "terminal" or "remote".`),
        );
        process.exit(1);
      }
      return {
        startingMode: startingRuntimeMode
          ? codexRuntimeModeToHostStartingMode(startingRuntimeMode)
          : undefined,
        directory,
      };
    },
  });
}
