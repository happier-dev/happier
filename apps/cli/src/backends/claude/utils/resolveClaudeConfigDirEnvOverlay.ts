import { resolveClaudeConfigDirOverride } from './resolveClaudeConfigDirOverride';

export function resolveClaudeConfigDirEnvOverlay(env: NodeJS.ProcessEnv): Record<string, string> {
  const claudeConfigDir = resolveClaudeConfigDirOverride(env);
  if (!claudeConfigDir) {
    return {};
  }

  return {
    CLAUDE_CONFIG_DIR: claudeConfigDir,
  };
}
