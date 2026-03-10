import type { DaemonSpawnHooks } from '@/daemon/spawnHooks';
import { validateProviderCliSpawn } from '@/runtime/managedTools/validateProviderCliSpawn';

export const opencodeDaemonSpawnHooks: DaemonSpawnHooks = {
  buildAuthEnv: async ({ token }) => ({
    env: { CLAUDE_CODE_OAUTH_TOKEN: token },
    cleanupOnFailure: null,
    cleanupOnExit: null,
  }),
  validateSpawn: async () => validateProviderCliSpawn({ agentId: 'opencode' }),
};
