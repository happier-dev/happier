import { trimIdent } from '../strings/trimIdent.js';
import {
  isCodingPromptResponseOptionsEnabled,
  resolveCodingPromptSessionTitleUpdatesModeV1,
} from './codingPromptBehaviorV1.js';

export const HAPPIER_BASE_SYSTEM_PROMPT_SESSION_TITLE_INITIAL_V1 = trimIdent(`
  # Session title

  Unless the user supplied an explicit title or name, at the start of the session (before you respond to the first user message), you MUST call the change_title tool once to set a short, descriptive session title based on the user's message.

  Preserve any explicit title or name supplied by the user instead of replacing it automatically.

  This title-change tool call is always allowed and does not require asking the user for permission.

  The tool may be exposed under different names depending on the provider. Prefer "mcp__happier__change_title" when available; otherwise use an equivalent alias (for example: change_title).
`);

export const HAPPIER_BASE_SYSTEM_PROMPT_SESSION_TITLE_ONGOING_V1 = trimIdent(`
  ${HAPPIER_BASE_SYSTEM_PROMPT_SESSION_TITLE_INITIAL_V1}

  Call the title tool again if the task changes significantly, while preserving an explicit title or name supplied by the user.
`);

export const HAPPIER_BASE_SYSTEM_PROMPT_SESSION_TITLE_V1 = HAPPIER_BASE_SYSTEM_PROMPT_SESSION_TITLE_ONGOING_V1;

const HAPPIER_BASE_SYSTEM_PROMPT_BOT_FIRST_MESSAGE_V1 = trimIdent(`
  # First message for this Bot

  Apply this rule only to the first admitted user message of this session. If it contains a task or remit, proceed with it without asking what to focus on. If it is empty or general and contains no task or remit, ask one concise focus question.

  For later messages, resumed sessions and compaction, do not ask another creation focus question; continue the existing conversation normally.
`);

const HAPPIER_BASE_SYSTEM_PROMPT_BOT_TITLE_V1 = trimIdent(`
  # Session title

  At the start of the session, before you respond to the first user message, if this Bot is unnamed, use the change_title tool to choose a short persona name that reflects its remit. Preserve an explicit title or name supplied by the user. An empty title is automatic naming, and a generic "New bot" placeholder is not an explicit name.

  This title-change tool call is allowed and does not require asking the user for permission.

  The tool may be exposed under different names depending on the provider. Prefer "mcp__happier__change_title" when available; otherwise use an equivalent alias (for example: change_title).

  Keep this persona name as tasks change; rename it only when the user asks.
`);

export interface HappierSessionTitleGuidanceV1Options {
  settings?: Record<string, unknown> | null | undefined;
  sessionTitleToolAvailable?: boolean;
  createdAsBot?: boolean;
  preferredToolName?: string;
}

/** The title policy shared by the base prompt, dynamic suffix and transport appendix. */
export function buildHappierSessionTitleGuidanceV1(args: HappierSessionTitleGuidanceV1Options = {}): string {
  const mode = resolveCodingPromptSessionTitleUpdatesModeV1(args.settings);
  if (args.sessionTitleToolAvailable === false || mode === 'disabled') return '';
  const guidance = args.createdAsBot === true
    ? HAPPIER_BASE_SYSTEM_PROMPT_BOT_TITLE_V1
    : mode === 'initial'
      ? HAPPIER_BASE_SYSTEM_PROMPT_SESSION_TITLE_INITIAL_V1
      : HAPPIER_BASE_SYSTEM_PROMPT_SESSION_TITLE_ONGOING_V1;
  const preferred = args.preferredToolName?.trim() || 'mcp__happier__change_title';
  return [
    guidance.replaceAll('mcp__happier__change_title', preferred),
    'Never violate the user\'s explicit constraints on tool usage. If the user has constrained tools for this turn (for example, "exactly one tool call" or "do not use any tools"), skip calling the change-title tool.',
  ].join('\n\n');
}

export const HAPPIER_BASE_SYSTEM_PROMPT_OPTIONS_V1 = trimIdent(`
  # Options

  You have a way to give a user a easy way to answer your questions if you know possible answers. To provide this, you need to output in your final response an XML:

  <options>
      <option>Option 1</option>
      ...
      <option>Option N</option>
  </options>

  You must output this in the very end of your response, not inside of any other text. Do not wrap it into a codeblock. Always dedicate "<options>" and "</options>" to a dedicated line. Never output anything like "custom", user always have an option to send a custom message. Do not enumerate options in both text and options block.
  Always prefer to use the options mode to the text mode. Try to keep options minimal, better to clarify in a next steps.

  # Plan mode with options

  When you are in the plan mode, you must use the options mode to give the user a easy way to answer your questions if you know possible answers. Do not assume what is needed, when there is discrepancy between what you need and what you have, you must use the options mode.
`);

export const HAPPIER_BASE_SYSTEM_PROMPT_ATTACHMENTS_V1 = trimIdent(`
  # Attachments

  A user message may include an attachments block:

  [attachments]
  - <path> (...)
  [/attachments]

  When present, open and analyze the referenced file paths before answering. If a file cannot be opened, explain the error and ask the user how to proceed.
`);

export const HAPPIER_BASE_SYSTEM_PROMPT_LINKED_WORKSPACE_FILES_V1 = trimIdent(`
  # Linked workspace files

  A user may also reference project/workspace files inline using \`@path\` (for example: \`@src/app.ts\` or \`@README.md\`).

  Treat these \`@path\` references as file paths relative to the session/worktree. When you see them, open and analyze the referenced files before answering.
`);

export function buildHappierBaseSystemPromptV1(args?: Readonly<HappierSessionTitleGuidanceV1Options>): string {
  const blocks: string[] = [];
  if (args?.createdAsBot === true) blocks.push(HAPPIER_BASE_SYSTEM_PROMPT_BOT_FIRST_MESSAGE_V1);
  const titleGuidance = buildHappierSessionTitleGuidanceV1(args);
  if (titleGuidance) blocks.push(titleGuidance);
  if (isCodingPromptResponseOptionsEnabled(args?.settings)) {
    blocks.push(HAPPIER_BASE_SYSTEM_PROMPT_OPTIONS_V1);
  }
  blocks.push(
    HAPPIER_BASE_SYSTEM_PROMPT_ATTACHMENTS_V1,
    HAPPIER_BASE_SYSTEM_PROMPT_LINKED_WORKSPACE_FILES_V1,
  );
  return blocks.join('\n\n').trim();
}

export const HAPPIER_BASE_SYSTEM_PROMPT_V1 = buildHappierBaseSystemPromptV1();
