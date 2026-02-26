/**
 * changeTitleInstruction
 *
 * Builds provider-agnostic instruction text for setting (and updating) the session title.
 *
 * Different providers/transports may expose the same tool under different names (canonical vs MCP vs legacy).
 * This module keeps the instruction resilient by mentioning a preferred name plus a small set of fallbacks.
 */
import { CHANGE_TITLE_TOOL_NAME_ALIASES } from '@happier-dev/protocol/tools/v2';
import { trimIdent } from '@/utils/trimIdent';

export interface ChangeTitleInstructionOptions {
  /**
   * Preferred tool name to mention first.
   *
   * Defaults to the preferred MCP tool name (`mcp__happier__change_title`).
   */
  preferredToolName?: string;
}

export const buildChangeTitleInstruction = (opts: ChangeTitleInstructionOptions = {}): string => {
  const preferred = (opts.preferredToolName ?? 'mcp__happier__change_title').trim();
  const fallbacks = CHANGE_TITLE_TOOL_NAME_ALIASES.filter((n) => n !== preferred);
  const fallbackPreview = fallbacks.slice(0, 3).join(', ');

  return trimIdent(
    `Based on the user's message, call the change-title tool to set (or update) a short, descriptive session title.

The tool may be exposed under different names depending on the provider. Prefer "${preferred}" when available; otherwise use an equivalent alias (for example: ${fallbackPreview}).

Call this tool again if the task changes significantly.`,
  );
};

export const CHANGE_TITLE_INSTRUCTION = buildChangeTitleInstruction();
