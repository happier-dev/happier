/**
 * Claude native `/goal` command builder.
 *
 * Wraps the literal `/goal` slash-command format in one place so it never
 * scatters across the effector (live-RPC inject + initial-goal injection).
 * Mirrors remote-dev's `claudeGoalCommand.ts` shape (`{ type:'set'; objective }`
 * / `{ type:'clear' }`) and its `/goal clear` vs `/goal <objective>` formatting.
 */

export type ClaudeGoalCommandRequest =
  | Readonly<{ type: 'set'; objective: string }>
  | Readonly<{ type: 'clear' }>;

/**
 * Collapse interior newline runs (incl. CRLF and the horizontal whitespace that
 * hugs them) into a single space. The objective is injected as a `/goal …` user
 * turn into Claude's TUI; a raw newline would submit the command prematurely at
 * the first line break. Pure horizontal whitespace runs (e.g. `a   b`) are left
 * intact so the objective text is preserved as the user typed it.
 */
function collapseObjectiveNewlines(objective: string): string {
  return objective.replace(/[ \t]*[\r\n]+[ \t]*/gu, ' ').trim();
}

/** Build the literal `/goal` user-turn text Claude's TUI consumes. */
export function buildClaudeGoalCommand(request: ClaudeGoalCommandRequest): string {
  if (request.type === 'clear') {
    return '/goal clear';
  }
  return `/goal ${collapseObjectiveNewlines(request.objective)}`;
}
