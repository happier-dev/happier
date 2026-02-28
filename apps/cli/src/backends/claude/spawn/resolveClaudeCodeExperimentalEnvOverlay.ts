export const CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS_ENV_VAR = 'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS' as const;

export function resolveClaudeCodeExperimentalEnvOverlay(params: Readonly<{
  claudeCodeExperimentalAgentTeamsEnabled?: boolean;
}>): Record<string, string> {
  if (params.claudeCodeExperimentalAgentTeamsEnabled !== true) {
    return {};
  }
  return { [CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS_ENV_VAR]: '1' };
}
