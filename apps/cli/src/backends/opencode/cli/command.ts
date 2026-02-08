import chalk from 'chalk';

import { authAndSetupMachineIfNeeded } from '@/ui/auth';
import { parseSessionStartArgs } from '@/cli/sessionStartArgs';
import { applyDeprecatedSessionStartAliasesForAgent } from '@/cli/sessionStartArgs';

import type { CommandContext } from '@/cli/commandRegistry';

export async function handleOpenCodeCliCommand(context: CommandContext): Promise<void> {
  try {
    const { runOpenCode } = await import('@/backends/opencode/runOpenCode');

    const parsed = parseSessionStartArgs(context.args);
    const resolved = applyDeprecatedSessionStartAliasesForAgent({ agentId: 'opencode', ...parsed });
    for (const warning of resolved.warnings) {
      console.error(chalk.yellow(warning));
    }
    const { startedBy, permissionMode, permissionModeUpdatedAt, agentModeId, agentModeUpdatedAt, modelId, modelUpdatedAt } = resolved;

    const readFlagValue = (flag: string): string | undefined => {
      const idx = context.args.indexOf(flag);
      if (idx === -1) return undefined;
      const value = context.args[idx + 1];
      if (!value || value.startsWith('-')) return undefined;
      return value;
    };

    const existingSessionId = readFlagValue('--existing-session');
    const resume = readFlagValue('--resume');

    const { credentials } = await authAndSetupMachineIfNeeded();
    await runOpenCode({
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
    });
  } catch (error) {
    console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error');
    if (process.env.DEBUG) {
      console.error(error);
    }
    process.exit(1);
  }
}
