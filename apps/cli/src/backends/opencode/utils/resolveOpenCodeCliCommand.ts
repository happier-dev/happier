export { type ProviderCliLaunchSpec } from '@/runtime/managedTools/requireProviderCliLaunchSpec';
import { requireProviderCliLaunchSpec } from '@/runtime/managedTools/requireProviderCliLaunchSpec';
import type { ProviderCliLaunchSpec } from '@/runtime/managedTools/requireProviderCliLaunchSpec';

export function resolveOpenCodeCliLaunchSpec(
  processEnv: NodeJS.ProcessEnv = process.env,
): ProviderCliLaunchSpec {
  return requireProviderCliLaunchSpec('opencode', { processEnv });
}
