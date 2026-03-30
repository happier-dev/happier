export function resolveClaudeConfigDirOverride(env: NodeJS.ProcessEnv): string | null {
  const explicit = typeof env.CLAUDE_CONFIG_DIR === 'string' ? env.CLAUDE_CONFIG_DIR.trim() : '';
  if (explicit.length > 0) return explicit;
  const happierOverride =
    typeof env.HAPPIER_CLAUDE_CONFIG_DIR === 'string' ? env.HAPPIER_CLAUDE_CONFIG_DIR.trim() : '';
  return happierOverride.length > 0 ? happierOverride : null;
}
