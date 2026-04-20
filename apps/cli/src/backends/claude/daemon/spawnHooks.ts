import type { DaemonSpawnHooks } from '../../../daemon/spawnHooks';
import { validateProviderCliSpawn } from '../../../runtime/managedTools/validateProviderCliSpawn';
import { resolveClaudeConfigDirOverride } from '../utils/resolveClaudeConfigDirOverride';
import { resolveClaudeConfigDirEnvOverlay } from '../utils/resolveClaudeConfigDirEnvOverlay';

export const claudeDaemonSpawnHooks: DaemonSpawnHooks = {
  resolveRuntimePrerequisites: async () => validateProviderCliSpawn({ agentId: 'claude' }),
  augmentEnv: () => {
    return resolveClaudeConfigDirEnvOverlay(process.env);
  },
};
