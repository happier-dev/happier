import chalk from 'chalk';

import type { AgentId } from '@happier-dev/agents';

import type { Credentials } from '@/persistence';
import { authAndSetupMachineIfNeeded } from '@/ui/auth';
import type { CommandContext } from '@/cli/commandRegistry';
import {
  applyDeprecatedSessionStartAliasesForAgent,
  parseSessionStartArgs,
  readOptionalFlagValue,
  type ParsedSessionStartArgs,
} from '@/cli/sessionStartArgs';

type CommonBackendRunOptions = ParsedSessionStartArgs & {
  credentials: Credentials;
  terminalRuntime: CommandContext['terminalRuntime'];
  existingSessionId: string | undefined;
  resume: string | undefined;
};

export async function runBackendSessionCliCommand<Extra extends Record<string, unknown>>(params: {
  context: CommandContext;
  loadRun: () => Promise<(opts: CommonBackendRunOptions & Extra) => Promise<void>>;
  agentIdForDeprecatedAliases?: AgentId;
  resolveExtraOptions?: (args: string[]) => Extra;
}): Promise<void> {
  try {
    const parsed = parseSessionStartArgs(params.context.args);
    const resolved = params.agentIdForDeprecatedAliases
      ? applyDeprecatedSessionStartAliasesForAgent({ agentId: params.agentIdForDeprecatedAliases, ...parsed })
      : { ...parsed, warnings: [] as string[] };

    for (const warning of resolved.warnings) {
      console.error(chalk.yellow(warning));
    }

    const existingSessionId = readOptionalFlagValue(params.context.args, '--existing-session');
    const resume = readOptionalFlagValue(params.context.args, '--resume');
    const extraOptions = params.resolveExtraOptions ? params.resolveExtraOptions(params.context.args) : ({} as Extra);

    const run = await params.loadRun();
    const { credentials } = await authAndSetupMachineIfNeeded();

    await run({
      credentials,
      terminalRuntime: params.context.terminalRuntime,
      startedBy: resolved.startedBy,
      permissionMode: resolved.permissionMode,
      permissionModeUpdatedAt: resolved.permissionModeUpdatedAt,
      agentModeId: resolved.agentModeId,
      agentModeUpdatedAt: resolved.agentModeUpdatedAt,
      modelId: resolved.modelId,
      modelUpdatedAt: resolved.modelUpdatedAt,
      existingSessionId,
      resume,
      ...extraOptions,
    });
  } catch (error) {
    console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error');
    if (process.env.DEBUG) {
      console.error(error);
    }
    process.exit(1);
  }
}
