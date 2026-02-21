import { CHANGE_TITLE_TOOL_NAME_ALIASES } from '@happier-dev/protocol/tools/v2';

/**
 * Prompt Utilities
 *
 * Utilities for working with prompts, including change_title instruction detection.
 */

/**
 * Check if a prompt contains a change_title instruction/tool name.
 */
export function hasChangeTitleInstruction(prompt: string): boolean {
  const lower = prompt.toLowerCase();
  return CHANGE_TITLE_TOOL_NAME_ALIASES.some((alias) => lower.includes(alias));
}
