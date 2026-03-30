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
  'session_title_set',
  // Alternate delimiter seen in some transports
  'change-title',
  'session-title-set',
  // Preferred MCP naming
  'mcp__happier__change_title',
  'mcp__happier__session_title_set',
  // Legacy MCP naming during migration
  'mcp__happy__change_title',
  'mcp__happy__session_title_set',
  // Non-MCP-prefixed variants seen in some transports/providers
  'happier__change_title',
  'happy__change_title',
  'happier__session_title_set',
  'happy__session_title_set',
  // OpenCode MCP client naming (single underscore between server + tool)
  'happier_change_title',
  'happy_change_title',
  'happier_session_title_set',
  'happy_session_title_set',
] as const;

export const ChangeTitleToolNameAliasSchema = z.enum(CHANGE_TITLE_TOOL_NAME_ALIASES);
export type ChangeTitleToolNameAlias = z.infer<typeof ChangeTitleToolNameAliasSchema>;

const CHANGE_TITLE_TOOL_LIKE_ALIASES = new Set<string>([
  ...(CHANGE_TITLE_TOOL_NAME_ALIASES as readonly string[]).map((alias) => alias.replace(/-/g, '_')),
  'set_session_title',
]);

export function isChangeTitleToolNameAlias(name: string): boolean {
  const normalized = typeof name === 'string' ? name.trim().toLowerCase() : '';
  if (!normalized) return false;
  return (CHANGE_TITLE_TOOL_NAME_ALIASES as readonly string[]).includes(normalized);
}

export function isChangeTitleToolLikeName(name: string): boolean {
  const normalized = typeof name === 'string' ? name.trim().toLowerCase().replace(/[\s-]+/g, '_') : '';
  if (!normalized) return false;
  return CHANGE_TITLE_TOOL_LIKE_ALIASES.has(normalized);
}
