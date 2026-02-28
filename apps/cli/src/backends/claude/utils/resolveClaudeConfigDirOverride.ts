export function resolveClaudeConfigDirOverride(env: NodeJS.ProcessEnv): string | null {
  const raw = typeof env.CLAUDE_CONFIG_DIR === 'string' ? env.CLAUDE_CONFIG_DIR.trim() : '';
  return raw.length > 0 ? raw : null;
}
