/**
 * Prompt Utilities
 * 
 * Utilities for working with prompts, including change_title instruction detection.
 */

import { CHANGE_TITLE_TOOL_NAME_ALIASES } from '@happier-dev/protocol/tools/v2';

/**
 * Check if a prompt contains change_title instruction
 * 
 * @param prompt - The prompt text to check
 * @returns true if the prompt contains change_title (legacy/new MCP aliases included)
 */
export function hasChangeTitleInstruction(prompt: string): boolean {
  const lower = prompt.toLowerCase();
  return CHANGE_TITLE_TOOL_NAME_ALIASES.some((alias) => lower.includes(alias));
}
