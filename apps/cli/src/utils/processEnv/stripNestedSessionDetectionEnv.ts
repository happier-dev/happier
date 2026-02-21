/**
 * Some tools/IDEs set environment variables to detect "nested sessions".
 * If those variables leak into spawned processes, child tools may refuse to
 * start (e.g. to prevent recursive/nested execution).
 *
 * Today we strip Claude Code's nested-session detection variables.
 * Keep this helper backend-agnostic since the daemon and multiple backends
 * spawn child processes.
 */
export function stripNestedSessionDetectionEnv(input: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...input };
  delete out.CLAUDECODE;
  delete out.CLAUDE_CODE_ENTRYPOINT;
  return out;
}

