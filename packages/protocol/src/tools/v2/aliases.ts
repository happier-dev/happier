import { z } from 'zod';

/**
 * Provider tool names for a given canonical tool often differ.
 *
 * For example:
 * - MCP tool calls may surface as `mcp__<server>__<tool>`
 * - ACP providers may surface the canonical tool name directly
 * - Some transports may emit legacy or non-MCP-prefixed variants
 *
 * Keep this list centralized and shared between CLI + UI to prevent drift.
 */
export const CHANGE_TITLE_TOOL_NAME_ALIASES = [
  // Canonical
  'change_title',
  // Alternate delimiter seen in some transports
  'change-title',
  // Preferred MCP naming
  'mcp__happier__change_title',
  // Legacy MCP naming during migration
  'mcp__happy__change_title',
  // Non-MCP-prefixed variants seen in some transports/providers
  'happier__change_title',
  'happy__change_title',
  // OpenCode MCP client naming (single underscore between server + tool)
  'happier_change_title',
  'happy_change_title',
] as const;

export const ChangeTitleToolNameAliasSchema = z.enum(CHANGE_TITLE_TOOL_NAME_ALIASES);
export type ChangeTitleToolNameAlias = z.infer<typeof ChangeTitleToolNameAliasSchema>;

export function isChangeTitleToolNameAlias(name: string): boolean {
  const normalized = typeof name === 'string' ? name.trim().toLowerCase() : '';
  if (!normalized) return false;
  return (CHANGE_TITLE_TOOL_NAME_ALIASES as readonly string[]).includes(normalized);
}
