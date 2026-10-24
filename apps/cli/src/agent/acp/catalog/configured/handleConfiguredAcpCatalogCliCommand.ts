import type { CommandContext } from '@/cli/commandRegistry';
import { runBackendSessionCliCommand } from '@/cli/runBackendSessionCliCommand';
import { readOptionalFlagValue } from '@/cli/sessionStartArgs';

export async function handleConfiguredAcpCatalogCliCommand(context: CommandContext): Promise<void> {
  const configuredAcpBackendId = readOptionalFlagValue(context.args, '--backend');
  const backendId = typeof configuredAcpBackendId === 'string' ? configuredAcpBackendId.trim() : '';
  if (!backendId) {
    throw new Error('Usage: happier acp-catalog --backend <backend-id> [session options]');
  }

  await runBackendSessionCliCommand({
    context,
    loadAccountSettings: true,
    loadRun: async () => {
      const { runConfiguredAcpBackend } = await import('./runConfiguredAcpBackend');
      return (opts) => runConfiguredAcpBackend({
        ...opts,
        configuredAcpBackendId: backendId,
      });
    },
  });
}
