import { requireProviderCliCommand } from '@/runtime/managedTools/requireProviderCliCommand';

export function resolveOpenCodeCliCommand(
  processEnv: NodeJS.ProcessEnv = process.env,
): string {
  return requireProviderCliCommand('opencode', { processEnv });
}
