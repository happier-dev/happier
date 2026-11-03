import { isSessionHappierToolsEnabled } from '../reach/sessionCapabilityMetadataV1.js';
import { trimIdent } from '../strings/trimIdent.js';
import { SessionOwnerCompatibilityViewV1Schema } from '../sessions/metadata/sessionMetadataSchemasV1.js';
import { readLeadingCodingPromptPlanV1 } from './promptPlanV1.js';
import {
  isCodingPromptResponseOptionsEnabled,
  resolveCodingPromptSessionTitleUpdatesModeV1,
  resolveCodingPromptBehaviorV1,
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
  sessionMetadata?: unknown;
  createdAsBot?: boolean;
  preferredToolName?: string;
}

export interface HappierBaseSystemPromptV1Options extends HappierSessionTitleGuidanceV1Options {
  sessionCompactionToolAvailable?: boolean;
  sessionCompactionToolName?: string;
}

const HAPPIER_SESSION_COMPACTION_NUDGE_V1 = 'In long sessions, when you finish a large piece of work and are about to move to a different one, call `session_compact`.';

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

  When present, open and analyze the referenced file paths before answering. Relative paths are relative to the session working directory, not your home directory. If a file cannot be opened, explain the error and ask the user how to proceed.
`);

export const HAPPIER_BASE_SYSTEM_PROMPT_LINKED_WORKSPACE_FILES_V1 = trimIdent(`
  # Linked workspace files

  A user may also reference project/workspace files inline using \`@path\` (for example: \`@src/app.ts\` or \`@README.md\`).

  Treat these \`@path\` references as file paths relative to the session/worktree. When you see them, open and analyze the referenced files before answering.
`);

export function buildHappierBaseSystemPromptV1(args?: Readonly<HappierBaseSystemPromptV1Options>): string {
  const blocks: string[] = [];
  if (args?.createdAsBot === true) blocks.push(HAPPIER_BASE_SYSTEM_PROMPT_BOT_FIRST_MESSAGE_V1);
  const titleGuidance = buildHappierSessionTitleGuidanceV1(args);
  if (titleGuidance) blocks.push(titleGuidance);
  if (resolveCodingPromptBehaviorV1(args?.settings).sessionCompactionNudge
    && args?.sessionCompactionToolAvailable === true && isSessionHappierToolsEnabled(args.sessionMetadata)) {
    const metadata = args.sessionMetadata && typeof args.sessionMetadata === 'object' && !Array.isArray(args.sessionMetadata)
      ? args.sessionMetadata as Record<string, unknown> : null;
    const capabilities = SessionOwnerCompatibilityViewV1Schema.shape.agentRuntimeCapabilitiesV1.safeParse(metadata?.agentRuntimeCapabilitiesV1);
    if (capabilities.success && capabilities.data?.sessionCapabilities?.compaction?.manual === true) {
      blocks.push(HAPPIER_SESSION_COMPACTION_NUDGE_V1.replace('`session_compact`',
        `\`${args.sessionCompactionToolName?.trim() || 'mcp__happier__session_compact'}\``));
    }
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

const HAPPIER_BASE_SYSTEM_PROMPT_DISPLAY_BLOCKS_V1 = (() => {
  // The moving 0.2 predecessor (f18aba940c) emits this earlier title policy.
  const predecessorInitial = HAPPIER_BASE_SYSTEM_PROMPT_SESSION_TITLE_INITIAL_V1
    .replace('Unless the user supplied an explicit title or name, at', 'At')
    .replace('\n\nPreserve any explicit title or name supplied by the user instead of replacing it automatically.', '');
  const blocks = [
    HAPPIER_SESSION_COMPACTION_NUDGE_V1,
    HAPPIER_SESSION_COMPACTION_NUDGE_V1.replace('`session_compact`', '`mcp__happier__session_compact`'),
    buildHappierSessionTitleGuidanceV1({ createdAsBot: true }),
    buildHappierSessionTitleGuidanceV1(),
    buildHappierSessionTitleGuidanceV1({ settings: { codingPromptBehaviorV1: { sessionTitleUpdates: 'initial' } } }),
    HAPPIER_BASE_SYSTEM_PROMPT_BOT_FIRST_MESSAGE_V1,
    HAPPIER_BASE_SYSTEM_PROMPT_BOT_TITLE_V1,
    HAPPIER_BASE_SYSTEM_PROMPT_SESSION_TITLE_ONGOING_V1,
    HAPPIER_BASE_SYSTEM_PROMPT_SESSION_TITLE_INITIAL_V1,
    `${predecessorInitial}\n\nCall the title tool again if the task changes significantly.`,
    predecessorInitial,
    HAPPIER_BASE_SYSTEM_PROMPT_OPTIONS_V1,
    HAPPIER_BASE_SYSTEM_PROMPT_ATTACHMENTS_V1,
    HAPPIER_BASE_SYSTEM_PROMPT_LINKED_WORKSPACE_FILES_V1,
  ];
  // Candidate indexes can already contain whitespace-normalized fallback text.
  return blocks.flatMap(block => [block, block.replaceAll('mcp__happier__change_title', 'change_title')])
    .flatMap(block => [block.trim(), block.replace(/\s+/g, ' ').trim()])
    .sort((left, right) => right.length - left.length);
})();

/** Presentation only: remove complete host-authored prefix blocks, never headings alone. */
function stripHappierBaseSystemPromptV1(text: string, contributedBlocks: readonly string[]): string {
  let remaining = text;
  while (true) {
    const prefix = remaining.trimStart();
    const matches = (value: string) => value.length > 0 && prefix.startsWith(value)
      && (prefix.length === value.length || /^\s/.test(prefix.slice(value.length)));
    const block = contributedBlocks.find(matches) ?? HAPPIER_BASE_SYSTEM_PROMPT_DISPLAY_BLOCKS_V1.find(matches);
    if (!block) return remaining;
    remaining = prefix.slice(block.length).trimStart();
  }
}

/** Presentation inverse of host prompt prefixes, never provenance or authority. */
export function readSessionInputPromptUserTextV1(text: string, contributedBlocks: readonly string[] = []): string {
  let remaining = text;
  while (true) {
    const withoutPlan = readLeadingCodingPromptPlanV1(remaining,
      content => content.length > 0 && stripHappierBaseSystemPromptV1(content, contributedBlocks) === '');
    if (withoutPlan !== null) { remaining = withoutPlan; continue; }
    const withoutBase = stripHappierBaseSystemPromptV1(remaining, contributedBlocks);
    if (withoutBase !== remaining) { remaining = withoutBase; continue; }
    // Per-send context and plugin resources cannot be reconstructed here.
    // Their tags and lengths prove no authorship, so keep them inspectable.
    return withoutBase;
  }
}
