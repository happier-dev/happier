import { trimIdent } from '../strings/trimIdent.js';
import {
  isCodingPromptResponseOptionsEnabled,
  resolveCodingPromptSessionTitleUpdatesModeV1,
} from './codingPromptBehaviorV1.js';

export const HAPPIER_BASE_SYSTEM_PROMPT_SESSION_TITLE_INITIAL_V1 = trimIdent(`
  # Session title

  At the start of the session (before you respond to the first user message), you MUST call the change_title tool once to set a short, descriptive session title based on the user's message.

  This title-change tool call is always allowed and does not require asking the user for permission.

  The tool may be exposed under different names depending on the provider. Prefer "mcp__happier__change_title" when available; otherwise use an equivalent alias (for example: change_title).
`);

export const HAPPIER_BASE_SYSTEM_PROMPT_SESSION_TITLE_ONGOING_V1 = trimIdent(`
  ${HAPPIER_BASE_SYSTEM_PROMPT_SESSION_TITLE_INITIAL_V1}

  Call the title tool again if the task changes significantly.
`);

export const HAPPIER_BASE_SYSTEM_PROMPT_SESSION_TITLE_V1 = HAPPIER_BASE_SYSTEM_PROMPT_SESSION_TITLE_ONGOING_V1;

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

export function buildHappierBaseSystemPromptV1(args?: Readonly<{
  settings?: Record<string, unknown> | null | undefined;
}>): string {
  const blocks: string[] = [];
  const sessionTitleUpdatesMode = resolveCodingPromptSessionTitleUpdatesModeV1(args?.settings);
  if (sessionTitleUpdatesMode === 'initial') {
    blocks.push(HAPPIER_BASE_SYSTEM_PROMPT_SESSION_TITLE_INITIAL_V1);
  } else if (sessionTitleUpdatesMode === 'ongoing') {
    blocks.push(HAPPIER_BASE_SYSTEM_PROMPT_SESSION_TITLE_ONGOING_V1);
  }
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
