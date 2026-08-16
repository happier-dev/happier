import type { DaemonSpawnHooks } from '@/daemon/spawnHooks';
import { validateProviderCliSpawn } from '@/runtime/managedTools/validateProviderCliSpawn';
import { resolveClaudeConfigDirOverride } from '@/backends/claude/utils/resolveClaudeConfigDirOverride';
import { resolveClaudeConfigDirEnvOverlay } from '@/backends/claude/utils/resolveClaudeConfigDirEnvOverlay';
import { resolveClaudeExternalSandboxEnv } from '@/backends/claude/spawn/resolveClaudeExternalSandboxEnv';

export const claudeDaemonSpawnHooks: DaemonSpawnHooks = {
  validateSpawn: async () => validateProviderCliSpawn({ agentId: 'claude' }),
  buildExtraEnvForChild: () => {
    return {
      ...resolveClaudeConfigDirEnvOverlay(process.env),
      ...resolveClaudeExternalSandboxEnv(process.env),
    };
  },
};
