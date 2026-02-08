/**
 * Prompt Utilities
 * 
 * Utilities for working with prompts, including change_title instruction detection.
 */

/**
 * Check if a prompt contains change_title instruction
 * 
 * @param prompt - The prompt text to check
 * @returns true if the prompt contains change_title (legacy/new MCP aliases included)
 */
export function hasChangeTitleInstruction(prompt: string): boolean {
  const lower = prompt.toLowerCase();
  return lower.includes('change_title') ||
         lower.includes('happy__change_title') ||
         lower.includes('mcp__happy__change_title') ||
         lower.includes('happier__change_title') ||
         lower.includes('mcp__happier__change_title');
}
