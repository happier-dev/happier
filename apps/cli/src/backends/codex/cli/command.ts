import chalk from 'chalk';

import { authAndSetupMachineIfNeeded } from '@/ui/auth';
import { parseSessionStartArgs } from '@/cli/sessionStartArgs';

import type { CommandContext } from '@/cli/commandRegistry';

export async function handleCodexCliCommand(context: CommandContext): Promise<void> {
  try {
    const { startedBy, permissionMode, permissionModeUpdatedAt, agentModeId, agentModeUpdatedAt, modelId, modelUpdatedAt } = parseSessionStartArgs(context.args);

    const readFlagValue = (flag: string): string | undefined => {
      const idx = context.args.indexOf(flag);
      if (idx === -1) return undefined;
      const value = context.args[idx + 1];
      if (!value || value.startsWith('-')) return undefined;
      return value;
    };

    const existingSessionId = readFlagValue('--existing-session');
    const resume = readFlagValue('--resume');
    const startingModeRaw = readFlagValue('--happy-starting-mode');
    const startingMode =
      startingModeRaw === 'local' || startingModeRaw === 'remote' ? startingModeRaw : undefined;
    if (startingModeRaw && !startingMode) {
      console.error(chalk.red(`Invalid --happy-starting-mode: ${startingModeRaw}. Use "local" or "remote".`));
      process.exit(1);
    }

    const { runCodex } = await import('@/backends/codex/runCodex');
    const { credentials } = await authAndSetupMachineIfNeeded();
    await runCodex({
      credentials,
      startedBy,
      terminalRuntime: context.terminalRuntime,
      permissionMode,
      permissionModeUpdatedAt,
      agentModeId,
      agentModeUpdatedAt,
      modelId,
      modelUpdatedAt,
      existingSessionId,
      resume,
      startingMode,
    });
  } catch (error) {
    console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error');
    if (process.env.DEBUG) {
      console.error(error);
    }
    process.exit(1);
  }
}
