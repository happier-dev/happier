import { resolveClaudeCodeIncludeInNativeHistory } from '@happier-dev/agents';

export const CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS_ENV_VAR = 'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS' as const;

export function resolveClaudeSessionEnvOverlay(params: Readonly<{
  claudeCodeExperimentalAgentTeamsEnabled?: boolean;
  claudeCodeIncludeInNativeHistory?: unknown;
}>): Record<string, string> {
  return {
    ...(params.claudeCodeExperimentalAgentTeamsEnabled === true
      ? { [CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS_ENV_VAR]: '1' } : {}),
    // Claude Code 2.1.283/2.1.296 rewrite cli to sdk-cli on noninteractive runs.
    // Happier attribution survives and avoids the SDK history exclusion without
    // rewriting provider-owned transcripts.
    ...(resolveClaudeCodeIncludeInNativeHistory(params.claudeCodeIncludeInNativeHistory) ? { CLAUDE_CODE_ENTRYPOINT: 'happier' } : {}),
  };
}
