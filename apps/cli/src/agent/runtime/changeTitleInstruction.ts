import { CHANGE_TITLE_TOOL_NAME_ALIASES } from '@happier-dev/protocol/tools/v2';
import { trimIdent } from '@/utils/trimIdent';

export type ChangeTitleInstructionOptions = {
  /**
   * Preferred tool name to mention first.
   * Defaults to `mcp__happier__change_title` (MCP convention).
   */
  preferredToolName?: string;
};

export function buildChangeTitleInstruction(opts: ChangeTitleInstructionOptions = {}): string {
  const preferred = (opts.preferredToolName ?? 'mcp__happier__change_title').trim();
  const fallbacks = CHANGE_TITLE_TOOL_NAME_ALIASES.filter((n) => n !== preferred);
  const fallbackPreview = fallbacks.slice(0, 3).join(', ');

  return trimIdent(
    `Based on the user's message, use the chat title tool to set (or update) a short, descriptive session title.

The tool may be exposed under different names depending on the provider. Prefer "${preferred}" when available; otherwise use an equivalent alias (for example: ${fallbackPreview}).

Call this tool again if the task changes significantly.`
  );
}

/**
 * Default instruction used by backends that inject title instructions.
 */
export const CHANGE_TITLE_INSTRUCTION = buildChangeTitleInstruction();

