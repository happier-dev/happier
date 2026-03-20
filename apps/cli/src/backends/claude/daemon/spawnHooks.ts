import type { DaemonSpawnHooks } from '@/daemon/spawnHooks';
import { validateProviderCliSpawn } from '@/runtime/managedTools/validateProviderCliSpawn';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveClaudeConfigDirOverride } from '@/backends/claude/utils/resolveClaudeConfigDirOverride';

export const claudeDaemonSpawnHooks: DaemonSpawnHooks = {
  buildAuthEnv: async ({ token }) => {
    const env: Record<string, string> = token.startsWith('sk-ant-oat01-')
      ? { CLAUDE_CODE_SETUP_TOKEN: token }
      : { CLAUDE_CODE_OAUTH_TOKEN: token };
    return {
      env,
      cleanupOnFailure: null,
      cleanupOnExit: null,
    };
  },
  validateSpawn: async () => validateProviderCliSpawn({ agentId: 'claude' }),
  buildExtraEnvForChild: () => ({
    CLAUDE_CONFIG_DIR: resolveClaudeConfigDirOverride(process.env) ?? join(homedir(), '.claude'),
  }),
};
