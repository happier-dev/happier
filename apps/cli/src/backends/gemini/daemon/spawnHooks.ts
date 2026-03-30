import type { DaemonSpawnHooks } from '@/daemon/spawnHooks';
import { validateProviderCliSpawn } from '@/runtime/managedTools/validateProviderCliSpawn';

export const geminiDaemonSpawnHooks: DaemonSpawnHooks = {
  validateSpawn: async () => validateProviderCliSpawn({ agentId: 'gemini' }),
};
