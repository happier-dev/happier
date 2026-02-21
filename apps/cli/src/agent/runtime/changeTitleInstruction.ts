import { trimIdent } from '@/utils/trimIdent';

/**
 * Instruction for changing chat title.
 *
 * IMPORTANT: Different providers surface the same MCP tool under different names.
 * In practice, title changes may appear as one of:
 * - mcp__happier__change_title (preferred)
 * - mcp__happy__change_title (legacy)
 * - happier__change_title / happy__change_title (non-MCP-prefixed variants)
 * - change_title (canonical tool name)
 */
export const CHANGE_TITLE_INSTRUCTION = trimIdent(
  `Based on the user's message, use the chat title tool to set (or update) a short, descriptive session title.

The tool may be exposed under different names depending on the provider. Prefer "mcp__happier__change_title" when available; otherwise use the equivalent "change_title" tool.

Call this tool again if the task changes significantly.`
);

