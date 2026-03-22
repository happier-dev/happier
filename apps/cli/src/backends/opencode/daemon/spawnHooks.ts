import type { DaemonSpawnHooks } from '@/daemon/spawnHooks';
import { validateProviderCliSpawn } from '@/runtime/managedTools/validateProviderCliSpawn';

export const opencodeDaemonSpawnHooks: DaemonSpawnHooks = {
  validateSpawn: async () => validateProviderCliSpawn({ agentId: 'opencode' }),
};
