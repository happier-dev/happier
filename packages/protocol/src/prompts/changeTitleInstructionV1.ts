import { CHANGE_TITLE_TOOL_NAME_ALIASES } from '../tools/v2/aliases.js';
import { trimIdent } from '../strings/trimIdent.js';

export interface ChangeTitleInstructionV1Options {
  /**
   * Preferred tool name to mention first.
   *
   * Defaults to the preferred MCP tool name (`mcp__happier__change_title`).
   */
  preferredToolName?: string;
}

export function shouldAppendChangeTitleInstructionV1(userText: string): boolean {
  const lower = typeof userText === 'string' ? userText.toLowerCase() : '';
  if (!lower.trim()) return true;

  // Avoid adding extra tool pressure when the user explicitly constrains tool usage.
  // This prevents change-title from competing with prompts like "run exactly one tool call".
  const blocks = [
    'exactly one tool call',
    'do not use any other tools',
    'do not use any tools',
    'must not call any tools',
    'do not call any tools',
    'no tools',
  ];
  return !blocks.some((snippet) => lower.includes(snippet));
}

export function buildChangeTitleInstructionV1(opts: ChangeTitleInstructionV1Options = {}): string {
  const preferred = (opts.preferredToolName ?? 'mcp__happier__change_title').trim();
  const fallbacks = CHANGE_TITLE_TOOL_NAME_ALIASES.filter((n) => n !== preferred);
  const fallbackPreview = fallbacks.slice(0, 3).join(', ');

  return trimIdent(
    `Before you respond, call the change-title tool once to set (or update) a short, descriptive session title based on the user's message.

The tool may be exposed under different names depending on the provider. Prefer "${preferred}" when available; otherwise use an equivalent alias (for example: ${fallbackPreview}).

Never violate the user's explicit constraints on tool usage (for example: "exactly one tool call" or "do not use any other tools"). If the user has constrained tool usage for this turn, skip calling the change-title tool.

Call this tool again if the task changes significantly.`,
  );
}

export const CHANGE_TITLE_INSTRUCTION_V1 = buildChangeTitleInstructionV1();
