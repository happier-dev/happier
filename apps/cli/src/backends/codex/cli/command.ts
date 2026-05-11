import chalk from 'chalk';

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
    directoryFlags: ['-C', '--cd'],
    forwardModelFlag: true,
    versionFlags: ['-V', '--version'],
    resolveExtraOptions: (_args, parsed) => {
      const startingRuntimeModeRaw = parsed.startingMode;
      const startingRuntimeMode: CodexRuntimeMode | undefined =
        startingRuntimeModeRaw === 'terminal' || startingRuntimeModeRaw === 'remote'
          ? startingRuntimeModeRaw
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
        directory: parsed.directory,
        ...(parsed.providerArgs.length > 0 ? { codexArgs: parsed.providerArgs } : {}),
      };
    },
  });
}
