import type { CommandContext } from '@/cli/commandRegistry';
import { runBackendSessionCliCommand } from '@/cli/runBackendSessionCliCommand';
import { runPi } from '@/backends/pi/runPi';

export async function handlePiCliCommand(context: CommandContext): Promise<void> {
  await runBackendSessionCliCommand({
    context,
    loadRun: async () => runPi,
    agentIdForAccountSettings: 'pi',
    // Pi's own `--continue` / `-c` (pi-coding-agent `cli/args.js`) stays in providerArgs.
    resolveExtraOptions: (_args, parsed) => {
      const separator = parsed.providerArgs.indexOf('--');
      const flags = separator === -1 ? parsed.providerArgs : parsed.providerArgs.slice(0, separator);
      return { continueRecentSession: flags.some((arg) => arg === '--continue' || arg === '-c') };
    },
  });
}
