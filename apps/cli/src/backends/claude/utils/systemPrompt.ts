import { trimIdent } from "@/utils/trimIdent";
import { shouldIncludeCoAuthoredBy } from "./claudeSettings";

/**
 * Base system prompt shared across all configurations
 */
const BASE_SYSTEM_PROMPT = (() => trimIdent(`
		    Use the tool "mcp__happier__change_title" to set (or update) a short, descriptive chat title so the user can find this chat later.

	    RELIABILITY RULES (IMPORTANT):
	    - Tool-use sequencing is strict. If you use "AskUserQuestion", do NOT include any other tool_use in the same assistant turn. Wait for the user's answer before calling other tools.

	    ATTACHMENTS:
	    - If a user message includes an attachments block like:
	      [attachments]
	      - /path/to/file
	      [/attachments]
	      then read each referenced path with the Read tool before answering.
`))();

/**
 * Co-authored-by credits to append when enabled
 */
const CO_AUTHORED_CREDITS = (() => trimIdent(`
		    When making commit messages, instead of just giving co-credit to Claude, also give credit to Happier like so:

    <main commit message>

	    Generated with [Claude Code](https://claude.ai/code)
	    via [Happier](https://app.happier.dev)

	    Co-Authored-By: Claude <noreply@anthropic.com>
	    Co-Authored-By: Happier <yesreply@happier.dev>
	`))();

/**
 * System prompt with conditional Co-Authored-By lines based on Claude's settings.json configuration.
 * Settings are read once on startup for performance.
 */
export function getClaudeSystemPrompt(): string {
  const includeCoAuthored = shouldIncludeCoAuthoredBy();
  if (includeCoAuthored) {
    return BASE_SYSTEM_PROMPT + '\n\n' + CO_AUTHORED_CREDITS;
  }
  return BASE_SYSTEM_PROMPT;
}

// Backwards-compatible export name, but evaluated at call time (not module init).
export function systemPrompt(): string {
  return getClaudeSystemPrompt();
}
