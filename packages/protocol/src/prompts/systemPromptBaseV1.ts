import { trimIdent } from '../strings/trimIdent.js';
import { isSessionHappierToolsEnabled } from '../mcpServers/sessionSelectionV1.js';
import {
  isCodingPromptResponseOptionsEnabled,
  resolveCodingPromptSessionTitleInstructionModeV1,
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

  When present, open and analyze the referenced file paths before answering. Relative paths are relative to the session working directory, not your home directory. If a file cannot be opened, explain the error and ask the user how to proceed.
`);

export const HAPPIER_BASE_SYSTEM_PROMPT_LINKED_WORKSPACE_FILES_V1 = trimIdent(`
  # Linked workspace files

  A user may also reference project/workspace files inline using \`@path\` (for example: \`@src/app.ts\` or \`@README.md\`).

  Treat these \`@path\` references as file paths relative to the session/worktree. When you see them, open and analyze the referenced files before answering.
`);

const HAPPIER_BASE_SYSTEM_PROMPT_SESSION_REFERENCES_V1 = trimIdent(`
  # Referring to other Happier sessions

  Refer to other sessions by their actual Happier titles, including in status reports and reply options. Native peer names such as "happier-6e", short references, process ids and socket addresses are internal identifiers, not user-facing session names.

  Resolve the title and Happier session id through the available session tools (discover session.list when necessary). When correlating a native peer with a Happier session, match its underlying provider session id against the session inventory; do not infer identity from a short suffix, similar title or list order. If the mapping is unavailable or ambiguous, say so instead of guessing or asking the user to decode the identifier.

  In message prose, make each resolved session reference a Markdown link: [Actual session title](/session/ACTUAL_HAPPIER_SESSION_ID). Use the exact returned Happier id, not the provider id or peer name. Escape Markdown characters in the title. If an owning server id is needed, append ?serverId= with its URL-encoded value. In reply options, use the resolved title as plain text so selecting an option still sends the intended answer.
`);

export function buildHappierBaseSystemPromptV1(args?: Readonly<{
  settings?: Record<string, unknown> | null | undefined;
  sessionTitleToolAvailable?: boolean;
  sessionMetadata?: unknown;
}>): string {
  const blocks: string[] = [];
  const sessionTitleUpdatesMode = resolveCodingPromptSessionTitleInstructionModeV1(args?.settings, args?.sessionMetadata);
  const titleToolAvailable = args?.sessionTitleToolAvailable !== false && isSessionHappierToolsEnabled(args?.sessionMetadata);
  if (titleToolAvailable && sessionTitleUpdatesMode === 'initial') {
    blocks.push(HAPPIER_BASE_SYSTEM_PROMPT_SESSION_TITLE_INITIAL_V1);
  } else if (titleToolAvailable && sessionTitleUpdatesMode === 'ongoing') {
    blocks.push(HAPPIER_BASE_SYSTEM_PROMPT_SESSION_TITLE_ONGOING_V1);
  }
  if (isCodingPromptResponseOptionsEnabled(args?.settings)) {
    blocks.push(HAPPIER_BASE_SYSTEM_PROMPT_OPTIONS_V1);
  }
  blocks.push(
    HAPPIER_BASE_SYSTEM_PROMPT_ATTACHMENTS_V1,
    HAPPIER_BASE_SYSTEM_PROMPT_LINKED_WORKSPACE_FILES_V1,
    HAPPIER_BASE_SYSTEM_PROMPT_SESSION_REFERENCES_V1,
  );
  return blocks.join('\n\n').trim();
}

export const HAPPIER_BASE_SYSTEM_PROMPT_V1 = buildHappierBaseSystemPromptV1();
