import type { PluginHookDecisionResult } from '@happier-dev/plugin-sdk/hooks';

export async function resolvePiDaemonSpawnPrerequisites(
  _event: unknown,
  _context?: unknown,
): Promise<PluginHookDecisionResult> {
  return { decision: 'allow' };
}
