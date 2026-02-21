import { z } from 'zod';

/**
 * Provider tool names for a given canonical tool often differ.
 *
 * For example, an MCP tool call may surface as:
 * - mcp__<server>__<tool>
 * while an ACP provider may surface the canonical tool name directly.
 *
 * Keep this list centralized and shared between CLI + UI to prevent drift.
 */
export const CHANGE_TITLE_TOOL_NAME_ALIASES = [
  // Canonical
  'change_title',
  // Preferred MCP naming
  'mcp__happier__change_title',
  // Legacy MCP naming during migration
  'mcp__happy__change_title',
  // Non-MCP-prefixed variants seen in some transports/providers
  'happier__change_title',
  'happy__change_title',
] as const;

export const ChangeTitleToolNameAliasSchema = z.enum(CHANGE_TITLE_TOOL_NAME_ALIASES);
export type ChangeTitleToolNameAlias = z.infer<typeof ChangeTitleToolNameAliasSchema>;

export function isChangeTitleToolNameAlias(name: string): boolean {
  return (CHANGE_TITLE_TOOL_NAME_ALIASES as readonly string[]).includes(name);
}
