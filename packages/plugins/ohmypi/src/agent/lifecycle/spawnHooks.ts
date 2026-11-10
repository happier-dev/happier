import type { PluginHookDecisionResult } from '@happier-dev/plugin-sdk/hooks';

export async function resolveOhMyPiDaemonSpawnPrerequisites(
  _event: unknown,
  _context?: unknown,
): Promise<PluginHookDecisionResult> {
  // Qualified account preparation and native model selection happen at open.
  return { decision: 'allow' };
}
