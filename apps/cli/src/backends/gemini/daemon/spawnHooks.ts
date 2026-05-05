import type { DaemonSpawnHooks } from '../../../daemon/spawnHooks';
import { validateProviderCliSpawn } from '@/packagedRuntime/managedTools/validateProviderCliSpawn';

export const geminiDaemonSpawnHooks: DaemonSpawnHooks = {
  resolveRuntimePrerequisites: async () => validateProviderCliSpawn({ agentId: 'gemini' }),
};
