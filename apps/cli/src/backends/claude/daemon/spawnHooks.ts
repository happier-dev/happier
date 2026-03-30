import type { DaemonSpawnHooks } from '@/daemon/spawnHooks';
import { validateProviderCliSpawn } from '@/runtime/managedTools/validateProviderCliSpawn';
import { resolveClaudeConfigDirOverride } from '@/backends/claude/utils/resolveClaudeConfigDirOverride';

export const claudeDaemonSpawnHooks: DaemonSpawnHooks = {
  validateSpawn: async () => validateProviderCliSpawn({ agentId: 'claude' }),
  buildExtraEnvForChild: () => {
    const claudeConfigDir = resolveClaudeConfigDirOverride(process.env);
    const env: Record<string, string> = {};
    if (claudeConfigDir) {
      env.CLAUDE_CONFIG_DIR = claudeConfigDir;
    }
    return env;
  },
};
