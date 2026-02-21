/**
 * Claude Code uses these environment variables to detect when it's running
 * inside another Claude Code session. If they leak into spawned processes,
 * nested session detection can prevent Claude Code from starting.
 */
export function stripNestedClaudeCodeEnv(input: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...input };
  delete out.CLAUDECODE;
  delete out.CLAUDE_CODE_ENTRYPOINT;
  return out;
}

