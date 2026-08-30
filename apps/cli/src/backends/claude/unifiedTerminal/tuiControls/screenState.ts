import { normalizeCapturedScreen, stripTerminalControlSequences } from '@/integrations/terminalHost/controlCapture';

import { hasComposerLineStyleEvidence, SGR_SEQUENCE_PREFIX } from './composerStyleEvidence';
import type { ClaudeTuiModeMarker } from './types';

export type ClaudeUnifiedSafeguardPauseChoice = 'switch_model' | 'edit_prompt_and_retry';

export type ClaudeUnifiedSafeguardPauseDialogOption = Readonly<{
  choice: ClaudeUnifiedSafeguardPauseChoice;
  label: string;
  modelLabel?: string | undefined;
}>;

export type ClaudeUnifiedGenericNumberedDialog = Readonly<{
  context: readonly string[];
  options: readonly Readonly<{ choice: string; label: string }>[];
  /** Stable, bounded representation of the exact visible context and options. */
  signature: string;
}>;

/**
 * Parsed Claude Unified TUI screen state used to gate runtime controls.
 *
 * Parsing operates on a normalized capture (ANSI/control sequences already stripped by the shared
 * `controlCapture` owner). This is for control verification and readiness ONLY — never for
 * screen-derived permission approval. Markers and fixtures are keyed to Claude Code 2.1.170 probe
 * captures; new versions add fixtures rather than mutating these in place.
 */
export type ClaudeScreenState = Readonly<{
  text: string;
  inputBoxInteractive: boolean;
  generating: boolean;
  slashPickerOpen: boolean;
  permissionEditorOpen: boolean;
  permissionPromptVisible: boolean;
  trustFolderPromptVisible: boolean;
  switchModelDialogVisible: boolean;
  /** Claude usage/session-limit prompt opened by `/rate-limit-options`; provider is unavailable. */
  usageLimitDialogVisible: boolean;
  /** Safe bounded capture of the currently visible numbered block, including recognized dialogs. */
  visibleNumberedDialog: ClaudeUnifiedGenericNumberedDialog | null;
  /** Heavy-session startup interstitial: "Resume from summary" / "Resume full session". */
  resumeChoiceDialogVisible: boolean;
  /** Proven option order for the heavy-session resume interstitial. */
  resumeChoiceDialogOptions: readonly ('resume_from_summary' | 'resume_full_session')[];
  /** Fable-safeguard pause chooser: "Session paused" with switch/retry options. */
  safeguardPauseDialogVisible: boolean;
  /** Proven option order and labels for the safeguard pause chooser. */
  safeguardPauseDialogOptions: readonly ClaudeUnifiedSafeguardPauseDialogOption[];
  /** `Change effort level?` confirmation dialog (live probe 2.1.173, incident cmq8y3nlx L6). */
  effortChangeDialogVisible: boolean;
  /**
   * A `❯`-numbered selection dialog whose heading matches NO recognized matcher (P-B fail-closed):
   * e.g. a confirmation added by a newer Claude build. Typing answers it and Escape declines it, so
   * controls/steering must fail closed (`requires_interactive_control`) instead of touching it.
   */
  unrecognizedConfirmationDialogVisible: boolean;
  /** Safe generic presentation, or null when the numbered prompt is incomplete or ambiguous. */
  unrecognizedConfirmationDialog: ClaudeUnifiedGenericNumberedDialog | null;
  /** Lowercased target level from the dialog body ("Switching to high means…"), when visible. */
  effortChangeDialogTarget: string | null;
  /**
   * Latest effort confirmation row on screen by position (screens keep older confirmations in
   * scrollback; the lowest row is the most recent). `kept` = the dialog was declined
   * ("Kept effort level as <x>"); `set` = an applied confirmation.
   */
  latestEffortConfirmation: Readonly<{ kind: 'set' | 'kept'; level: string }> | null;
  /** Count of visible "Kept effort level as" rows; lets callers detect a NEW decline vs stale rows. */
  keptEffortNoticeCount: number;
  queuedMessageBannerVisible: boolean;
  userDraftPresent: boolean;
  /**
   * Agents/selection panel that actually OWNS keyboard input: a `❯ ◯ …` focused cursor row (live
   * 2026-06-12 11:36 incident), or the `↑/↓ to select` header with NO interactive composer on
   * screen. The hint header alone is NOT enough: while background agents run, Claude renders a
   * PASSIVE tasks footer (`⏺ main … ↑/↓ to select · Enter to view` + unfocused `◯` rows) below a
   * fully interactive composer (live 2026-06-12 14:00 incident cmq9x64qc — steering starved
   * `selection_list` for the whole background-agent wait). Typing on that screen drives the
   * composer, so it must stay steerable.
   */
  selectionListVisible: boolean;
  /**
   * Exact (trimmed) content of the BOTTOM composer line, `''` when the composer is empty and null
   * when no composer line is found. The control modules use it to (a) detect a leftover
   * slash-command draft that passes the safe-window check with the picker closed and (b) prove the
   * composer holds EXACTLY the typed command before Enter — a concatenated leftover otherwise
   * submits `/effort medium/effort medium` (incident cmq7pyqkj, U1).
  */
  composerContent: string | null;
  composerCursorRelation: 'at_content_start' | 'inside_or_after_content' | null;
  modeMarker: ClaudeTuiModeMarker;
  visibleModel: string | null;
  visibleEffort: string | null;
}>;

export type ClaudeScreenParseContext = Readonly<{
  /** Zero-based terminal cursor coordinates, when supplied by the terminal host. */
  cursor?: Readonly<{ x: number; y: number }> | undefined;
}>;

const MAX_CURSOR_PROVEN_PLAIN_PLACEHOLDER_CHARS = 120;

const ESC_TO_INTERRUPT = /esc to interrupt/i;
// Real spinner lines do not always carry "esc to interrupt" (live capture 2026-06-11:
// `✽ Billowing… (10m 24s · ↓ 20.4k tokens)`). Detect the spinner-line shape: an animation glyph,
// a single status word, an ellipsis, then a parenthesized status group. Completion lines
// (`✻ Crunched for 6s`) have no parenthesized group and must NOT match.
const GENERATING_SPINNER_LINE = /(?:^|\n)[^\S\n]*[✶✻✽✳·∗*][^\S\n]+\S+…[^\S\n]*\(/u;
const QUEUED_MESSAGE_BANNER = /press up to edit queued messages/i;
const SWITCH_MODEL_DIALOG = /switch model\?/i;
// Claude renders the focused-row cursor according to terminal capabilities. Real captures include
// Unicode `❯`, narrow Unicode `›`, and ASCII `>`; treat them as one terminal presentation detail
// everywhere that parses a selection row. This is deliberately narrower than normalizing arbitrary
// glyphs: a numbered choice must still satisfy the owning dialog's full semantic shape.
const SELECTION_FOCUS_GLYPH_SOURCE = '[>›❯]';
const OPTIONAL_SELECTION_FOCUS_PREFIX_SOURCE = `(?:${SELECTION_FOCUS_GLYPH_SOURCE}[^\\S\\n]*)?`;
const RESUME_CHOICE_DIALOG_HEAD = /\bthis session is\b[\s\S]{0,500}\b(?:tokens?|old)\b/i;
const RESUME_CHOICE_FROM_SUMMARY_OPTION = new RegExp(
  `(?:^|\\n)[^\\S\\n]*${OPTIONAL_SELECTION_FOCUS_PREFIX_SOURCE}1\\.[^\\n]*\\bresume from summary\\b`,
  'iu',
);
const RESUME_CHOICE_FULL_SESSION_OPTION = new RegExp(
  `(?:^|\\n)[^\\S\\n]*${OPTIONAL_SELECTION_FOCUS_PREFIX_SOURCE}2\\.[^\\n]*\\bresume full session\\b`,
  'iu',
);
const SAFEGUARD_PAUSE_DIALOG_HEAD = /\bsession paused\b/i;
const SAFEGUARD_PAUSE_DIALOG_BODY = /\bsafeguards flagged this message\b/i;
const SAFEGUARD_PAUSE_SWITCH_OPTION = /\bswitch to\s+(.+?)\s*$/i;
const SAFEGUARD_PAUSE_RETRY_OPTION = /\bedit prompt and retry(?:\s+with\s+(.+?))?\s*$/i;
// The provider changes the paid alternatives across plans and releases. Recognize the stable
// failure + chooser + wait semantics, then require the shared strict numbered-dialog parser below.
// This stays tolerant of labels and option count without matching arbitrary numbered dialogs.
const USAGE_LIMIT_DIALOG = /(?:\byou(?:['’]ve| have)\s+(?:hit|reached)\s+your\s+(?:session|usage)\s+limit\b|\/rate-limit-options)[\s\S]{0,1200}\bwhat do you want to do\?[\s\S]{0,700}\bwait\b[^\n]{0,120}\blimit\b[^\n]{0,120}\breset(?:s)?\b/i;
const CROPPED_USAGE_LIMIT_DIALOG = /\bwhat do you want to do\?[\s\S]{0,400}(?:❯|>)\s*1\.\s*[^\n]{0,120}\bwait\b[^\n]{0,120}\blimit\b[^\n]{0,120}\breset(?:s)?\b/i;
// Live probe 2026-06-11 (Claude Code 2.1.173, tmux): `/effort <level>` on a conversation cached at a
// different effort opens "Change effort level? … ❯ 1. Yes, switch to <level>  2. No, go back".
// Escape / "No, go back" prints `Kept effort level as <current>` (incident cmq8y3nlx, L6).
const EFFORT_CHANGE_DIALOG = /change effort level\?/i;
// Selection-dialog option shape shared by every observed confirmation dialog (2.1.170 Switch
// model?, 2.1.173 Change effort level?): a terminal focus glyph directly on a numbered option line.
// Used to fail closed on dialogs we do NOT recognize. Composer prompt echoes (`❯ <prompt>`) only
// match when the prompt itself starts with `<digit>.` — accepted false-positive toward safety.
const NUMBERED_SELECTION_OPTION = new RegExp(
  `(?:^|\\n)[^\\S\\n]*${SELECTION_FOCUS_GLYPH_SOURCE}[^\\S\\n]*\\d+\\.`,
  'u',
);
const NUMBERED_DIALOG_OPTION_LINE = new RegExp(
  `^[^\\S\\n]*${OPTIONAL_SELECTION_FOCUS_PREFIX_SOURCE}(\\d+)\\.[^\\S\\n]+(.+?)[^\\S\\n]*$`,
  'u',
);
const FOCUSED_SELECTION_LINE = new RegExp(`^[^\\S\\n]*${SELECTION_FOCUS_GLYPH_SOURCE}`, 'u');
const EFFORT_CHANGE_DIALOG_TARGET = /switching to\s+([a-z]+)\s+means the full history/i;
const PERMISSION_PROMPT = /do you want to proceed\?/i;
// Legacy wording plus the real 2.1.170 `/permissions` editor tab row
// ("Permissions  Recently denied  Allow  Ask  Deny  Workspace"). The "Recently denied" + "Deny" tab
// pair is unique to the editor and never appears together in normal output.
const PERMISSION_EDITOR = /\bpermission rules\b/i;
const PERMISSION_EDITOR_HEADER = /\brecently denied\b[^\n]*\bdeny\b/i;
const TRUST_FOLDER_PROMPT = /(?:do you trust the files in this folder\?|quick safety check:\s*is this a project you created or one you trust\?)/i;
const TRUST_FOLDER_NUMBERED_CHOICES = new RegExp(
  `(?:^|\\n)[^\\S\\n]*${OPTIONAL_SELECTION_FOCUS_PREFIX_SOURCE}1\\.[^\\S\\n]+Yes, I trust this folder[^\\S\\n]*(?:\\n)[^\\S\\n]*${OPTIONAL_SELECTION_FOCUS_PREFIX_SOURCE}2\\.[^\\S\\n]+No, exit[^\\S\\n]*(?:$|\\n)`,
  'iu',
);
const WORK_PROMPT = /what would you like to work on\?/i;

const ACCEPT_EDITS_MARKER = /\baccept edits on\b/i;
const PLAN_MODE_MARKER = /\bplan mode on\b/i;
const AUTO_MODE_MARKER = /\bauto(?: mode)? on\b/i;
const BYPASS_MARKER = /\bbypass permissions on\b/i;

const MODEL_CONFIRMATION = /set model to\s+(.+?)(?:\s+and saved\b|\s*$)/im;
const MODEL_STATUS_LINE = /\bmodel:\s*([^\n]+?)\s*$/im;
// Real 2.1.170 text is "Set effort level to <x>"; older builds said "Set reasoning effort to <x>".
const EFFORT_CONFIRMATION = /set (?:reasoning )?effort (?:level )?to\s+([a-z]+)\b/gim;
const EFFORT_KEPT_NOTICE = /kept effort level as\s+([a-z]+)\b/gim;
const EFFORT_STATUS_LINE = /\beffort:\s*([a-z]+)\b/im;

// Composer prompt line: `>`, `›` (U+203A), or `❯` (U+276F, the real 2.1.170 glyph) followed by
// optional content (inside an optional box border). The negative lookahead excludes menu-selection
// lines (`❯ 1. Yes`) — the same `❯` glyph marks dialog choices — so a dialog never reads as an
// interactive composer (fail-closed: an ambiguous numbered line is treated as not-a-composer).
const COMPOSER_LINE = /(?:^|\n)[^\S\n]*(?:[│|][^\S\n]*)?(?:>|›|❯)(?![^\S\n]*(?:\d+\.|[◯◉○●◐◑]))[^\S\n]*(.*?)[^\S\n]*(?:[│|][^\S\n]*)?(?:\n|$)/;
const SLASH_SUGGESTION_LINE = /(?:^|\n)[^\S\n]*\/[a-z][a-z0-9-]*\b/i;
// Agents/selection panel (live capture 2026-06-12 11:50, runner pid 58731): the selector header
// renders `↑/↓ to select` and the focus cursor renders as `❯ ◯ <agent-type> <title>` rows. The
// cursor row must never read as a composer draft (false `user_draft` steer veto with a misleading
// "clear the draft" notice), and typing/Enter on this screen drives the SELECTOR, so it is a
// blocking overlay for controls and steering.
const SELECTION_LIST_HINT = /\u2191\/\u2193 to select/;
const SELECTION_CURSOR_ROW = new RegExp(
  `(?:^|\\n)[^\\S\\n]*${SELECTION_FOCUS_GLYPH_SOURCE}[^\\S\\n]*[◯◉○●◐◑]`,
  'u',
);


function tailLines(text: string, count: number): string {
  return text.split('\n').slice(-count).join('\n');
}

function lineIndexAt(text: string, index: number): number {
  let line = 0;
  for (let i = 0; i < index && i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

// Composer-box bottom border / horizontal rule. Require a horizontal/corner glyph: whitespace-only
// rows and vertical-only box rows can be intentional blank paragraphs inside the composer.
const COMPOSER_BORDER_LINE = /^[\s─━—╰╯╭╮│|]*[─━—╰╯╭╮][\s─━—╰╯╭╮│|]*$/;
// Status glyphs that can follow the composer when no border is rendered (fail-closed stop set).
const COMPOSER_CONTINUATION_STOP = /^[\s]*(?:[⏵←⏺✻✶·]|⚠)/;

/**
 * Continuation lines of a soft-wrapped composer draft (C11, live capture 2026-06-12, runner pid
 * 20327): a draft longer than the pane width wraps onto indented lines inside the composer box.
 * Capturing only the `❯` line truncated the draft, so an own-injected leftover could never
 * exact-match the own-text registry. Continuation = indented, non-border, non-status lines
 * between the composer line and the box bottom border.
 */
function readComposerContinuationLines(text: string, afterIndex: number): string[] {
  const rest = text.slice(afterIndex);
  const lines = rest.length === 0 ? [] : rest.split('\n');
  const continuation: string[] = [];
  for (const rawLine of lines) {
    // Strip box border verticals so `│   wrapped text   │` reads as an indented line.
    const line = rawLine.replace(/^[^\S\n]*[│|]/, '').replace(/[│|][^\S\n]*$/, '');
    if (COMPOSER_BORDER_LINE.test(line)) break;
    if (COMPOSER_CONTINUATION_STOP.test(line)) break;
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continuation.push('');
      continue;
    }
    if (!/^[^\S\n]/.test(line)) break;
    continuation.push(trimmed);
  }
  while (continuation.at(-1) === '') continuation.pop();
  return continuation;
}

function readComposerContentStartColumn(line: string): number | null {
  const promptIndex = line.search(/[>›❯]/u);
  if (promptIndex === -1) return null;
  let index = promptIndex + 1;
  while (index < line.length && /[^\S\n]/u.test(line[index] ?? '')) {
    index += 1;
  }
  return index;
}

/**
 * Walk one RAW (ANSI-bearing) screen line and return its visible characters annotated with the
 * SGR dim (faint, code 2) state active at each character. Codes 0/empty and 22 clear dim.
 */
function readStyledLineRuns(rawLine: string): ReadonlyArray<Readonly<{ char: string; dim: boolean; inverse: boolean }>> {
  const runs: Array<Readonly<{ char: string; dim: boolean; inverse: boolean }>> = [];
  let dim = false;
  let inverse = false;
  let index = 0;
  while (index < rawLine.length) {
    if (rawLine.startsWith(SGR_SEQUENCE_PREFIX, index)) {
      const end = rawLine.indexOf('m', index + 2);
      const body = end === -1 ? null : rawLine.slice(index + 2, end);
      if (body !== null && /^[0-9;]*$/.test(body)) {
        const codes = (body.length === 0 ? '0' : body).split(';');
        for (let codeIndex = 0; codeIndex < codes.length; codeIndex += 1) {
          const code = codes[codeIndex];
          // Extended foreground/background/underline colors encode their mode as the next
          // parameter (`38;2;r;g;b` / `38;5;n`). That `2` is RGB mode, not SGR faint.
          if (code === '38' || code === '48' || code === '58') {
            const colorMode = codes[codeIndex + 1];
            if (colorMode === '2') codeIndex += 4;
            else if (colorMode === '5') codeIndex += 2;
            continue;
          }
          if (code === '' || code === '0') {
            dim = false;
            inverse = false;
          } else if (code === '2') dim = true;
          else if (code === '7') inverse = true;
          else if (code === '22') dim = false;
          else if (code === '27') inverse = false;
        }
        index = end + 1;
        continue;
      }
    }
    if (rawLine.charCodeAt(index) === 0x1b) {
      // Non-SGR escape: skip the introducer; the shared stripper semantics are close enough for
      // a per-line dim walk (stray sequence bytes read as non-dim visible chars, fail-closed).
      index += 1;
      continue;
    }
    runs.push({ char: rawLine[index], dim, inverse });
    index += 1;
  }
  return runs;
}

/**
 * Claude Code renders empty-composer placeholder/suggestion text DIM (SGR 2) — live capture
 * 2026-06-12, 2.1.174 zellij `dump-screen --ansi`: `❯ \x1b[2m\x1b[23mcheck the output`. The
 * contextual-suggestion family has arbitrary wording (no `Try "<hint>"` quoting), so styling plus
 * the terminal cursor position are the honest discriminators from a real typed draft (which
 * renders at normal intensity). Fail-closed when neither source proves an empty composer.
 */
function composerContentIsDimPlaceholder(
  rawText: string,
  content: string,
  cursorRelation: ClaudeScreenState['composerCursorRelation'],
): boolean {
  if (content.length === 0) return false;
  if (!rawText.includes(SGR_SEQUENCE_PREFIX)) return false;
  const rawLines = rawText.replace(/\r\n?/g, '\n').split('\n');
  for (let lineIndex = rawLines.length - 1; lineIndex >= 0; lineIndex -= 1) {
    const rawLine = rawLines[lineIndex];
    const stripped = stripTerminalControlSequences(rawLine);
    if (!stripped.includes(content)) continue;
    // Only composer-shaped lines qualify; transcript echoes are handled identically (bottom-most
    // matching line wins, mirroring lastMatch over the normalized text).
    if (!/[>›❯]/.test(stripped)) continue;
    const runs = readStyledLineRuns(rawLine);
    const visible = runs.map((run) => run.char).join('');
    const start = visible.lastIndexOf(content);
    if (start === -1) return false;
    let checkedVisibleContent = false;
    let sawDimContent = false;
    for (let i = start; i < start + content.length; i += 1) {
      if (/[^\S\n]/u.test(runs[i]?.char ?? '')) continue;
      checkedVisibleContent = true;
      if (runs[i]?.dim === true) {
        sawDimContent = true;
        continue;
      }
      // tmux renders the character under the real cursor as inverse video, temporarily replacing
      // its DIM placeholder style. Accept only that first cell when the host cursor independently
      // proves the composer buffer begins there; a typed draft remains normal intensity.
      if (i === start && cursorRelation === 'at_content_start' && runs[i]?.inverse === true) continue;
      return false;
    }
    return checkedVisibleContent && sawDimContent;
  }
  return false;
}

export function isPlainComposerCaptureAmbiguous(params: Readonly<{
  rawText: string;
  screen: Pick<ClaudeScreenState, 'composerContent' | 'composerCursorRelation'>;
}>): boolean {
  const content = params.screen.composerContent ?? '';
  return (
    content.length > 0
    && content.length <= MAX_CURSOR_PROVEN_PLAIN_PLACEHOLDER_CHARS
    && !content.includes('\n')
    && !hasComposerLineStyleEvidence(params.rawText, content)
    && params.screen.composerCursorRelation !== 'inside_or_after_content'
  );
}

function readCursorComposerRelation(params: Readonly<{
  text: string;
  match: RegExpExecArray;
  content: string;
  context?: ClaudeScreenParseContext | undefined;
}>): ClaudeScreenState['composerCursorRelation'] {
  const cursor = params.context?.cursor;
  if (cursor === undefined) return null;
  const promptOffset = params.match[0].search(/[>›❯]/u);
  if (promptOffset === -1) return null;
  const promptIndex = params.match.index + promptOffset;
  const lineIndex = lineIndexAt(params.text, promptIndex);
  if (cursor.y !== lineIndex) return null;
  const lineStart = params.text.lastIndexOf('\n', promptIndex - 1) + 1;
  const lineEnd = params.text.indexOf('\n', promptIndex);
  const line = params.text.slice(lineStart, lineEnd === -1 ? params.text.length : lineEnd);
  const contentStartColumn = readComposerContentStartColumn(line);
  if (contentStartColumn === null) return null;
  if (params.content.length === 0) return 'at_content_start';
  return cursor.x <= contentStartColumn ? 'at_content_start' : 'inside_or_after_content';
}

function cursorProvesPlainPlaceholder(params: Readonly<{
  rawText: string;
  content: string;
  continuation: readonly string[];
  cursorRelation: ClaudeScreenState['composerCursorRelation'];
}>): boolean {
  return (
    params.cursorRelation === 'at_content_start'
    && !hasComposerLineStyleEvidence(params.rawText, params.content)
    && params.continuation.length === 0
    && params.content.length > 0
    && params.content.length <= MAX_CURSOR_PROVEN_PLAIN_PLACEHOLDER_CHARS
  );
}

function readComposerState(
  text: string,
  rawText: string,
  context?: ClaudeScreenParseContext | undefined,
): Readonly<{ content: string | null; cursorRelation: ClaudeScreenState['composerCursorRelation'] }> {
  // Executed prompts echo as `❯ <prompt>` transcript rows (live capture 2026-06-11); the REAL
  // composer is the LAST composer-shaped line on screen (the input box renders at the bottom).
  const match = lastMatch(new RegExp(COMPOSER_LINE.source, `${COMPOSER_LINE.flags}g`), text);
  if (!match) return { content: null, cursorRelation: null };
  const content = (match[1] ?? '').trim();
  const cursorRelation = readCursorComposerRelation({ text, match, content, context });
  if (content.length === 0) return { content, cursorRelation };
  const continuation = readComposerContinuationLines(text, match.index + match[0].length);
  if (continuation.length === 0 && composerContentIsDimPlaceholder(rawText, content, cursorRelation)) {
    return { content: '', cursorRelation };
  }
  if (cursorProvesPlainPlaceholder({ rawText, content, continuation, cursorRelation })) {
    return { content: '', cursorRelation };
  }
  return {
    content: continuation.length === 0 ? content : [content, ...continuation].join('\n'),
    cursorRelation,
  };
}

function resolveModeMarker(text: string): ClaudeTuiModeMarker {
  // Order matters only for disambiguation; markers are mutually exclusive in practice.
  if (ACCEPT_EDITS_MARKER.test(text)) return 'acceptEdits';
  if (PLAN_MODE_MARKER.test(text)) return 'plan';
  if (BYPASS_MARKER.test(text)) return 'bypassPermissions';
  if (AUTO_MODE_MARKER.test(text)) return 'auto';
  return 'default';
}

function resolveVisibleModel(text: string): string | null {
  const confirmation = MODEL_CONFIRMATION.exec(text);
  if (confirmation?.[1]) return confirmation[1].trim();
  const status = MODEL_STATUS_LINE.exec(text);
  return status?.[1] ? status[1].trim() : null;
}

function resolveResumeChoiceDialogOptions(text: string): readonly ('resume_from_summary' | 'resume_full_session')[] {
  // Restrict to the visible tail so old transcript scrollback cannot accidentally classify a clean
  // composer as a startup dialog.
  const tail = tailLines(text, 20);
  if (!RESUME_CHOICE_DIALOG_HEAD.test(tail)) return [];
  if (!RESUME_CHOICE_FROM_SUMMARY_OPTION.test(tail)) return [];
  if (!RESUME_CHOICE_FULL_SESSION_OPTION.test(tail)) return [];
  return ['resume_from_summary', 'resume_full_session'];
}

function readNumberedSelectionLabel(text: string, number: 1 | 2): string | null {
  const linePattern = new RegExp(
    `(?:^|\\n)[^\\S\\n]*${OPTIONAL_SELECTION_FOCUS_PREFIX_SOURCE}${number}\\.[^\\n]*`,
    'u',
  );
  const line = linePattern.exec(text)?.[0] ?? null;
  if (!line) return null;
  const label = line
    .replace(/^\n/, '')
    .replace(new RegExp(
      `^[^\\S\\n]*${OPTIONAL_SELECTION_FOCUS_PREFIX_SOURCE}\\d+\\.[^\\S\\n]*`,
      'u',
    ), '')
    .trim();
  return label.length > 0 ? label : null;
}

function resolveSafeguardPauseDialogOptions(text: string): readonly ClaudeUnifiedSafeguardPauseDialogOption[] {
  // The chooser can appear below arbitrary assistant scrollback; constrain detection to the visible
  // tail and require both the heading/body and the two known numbered choices.
  const tail = tailLines(text, 30);
  if (!SAFEGUARD_PAUSE_DIALOG_HEAD.test(tail) || !SAFEGUARD_PAUSE_DIALOG_BODY.test(tail)) return [];
  const switchLabel = readNumberedSelectionLabel(tail, 1);
  const retryLabel = readNumberedSelectionLabel(tail, 2);
  const switchModel = switchLabel ? SAFEGUARD_PAUSE_SWITCH_OPTION.exec(switchLabel)?.[1]?.trim() : null;
  const retryModel = retryLabel ? SAFEGUARD_PAUSE_RETRY_OPTION.exec(retryLabel)?.[1]?.trim() : null;
  if (!switchLabel || !retryLabel || !switchModel || !SAFEGUARD_PAUSE_RETRY_OPTION.test(retryLabel)) return [];
  return [
    { choice: 'switch_model', label: switchLabel, modelLabel: switchModel },
    ...(retryModel
      ? [{ choice: 'edit_prompt_and_retry' as const, label: retryLabel, modelLabel: retryModel }]
      : [{ choice: 'edit_prompt_and_retry' as const, label: retryLabel }]),
  ];
}

type EffortConfirmationSignal = Readonly<{ kind: 'set' | 'kept'; level: string; index: number }>;

function lastMatch(pattern: RegExp, text: string): RegExpExecArray | null {
  let last: RegExpExecArray | null = null;
  for (const match of text.matchAll(pattern)) last = match as RegExpExecArray;
  return last;
}

/**
 * The screen keeps OLDER effort confirmations in scrollback (live capture 2026-06-11), so the
 * authoritative signal is the one lowest on screen: the match with the largest index wins.
 */
function resolveLatestEffortConfirmation(text: string): EffortConfirmationSignal | null {
  const set = lastMatch(EFFORT_CONFIRMATION, text);
  const kept = lastMatch(EFFORT_KEPT_NOTICE, text);
  const setSignal: EffortConfirmationSignal | null = set?.[1]
    ? { kind: 'set', level: set[1].trim().toLowerCase(), index: set.index }
    : null;
  const keptSignal: EffortConfirmationSignal | null = kept?.[1]
    ? { kind: 'kept', level: kept[1].trim().toLowerCase(), index: kept.index }
    : null;
  if (setSignal && keptSignal) return keptSignal.index > setSignal.index ? keptSignal : setSignal;
  return setSignal ?? keptSignal;
}

function resolveVisibleEffort(text: string): string | null {
  const confirmation = lastMatch(EFFORT_CONFIRMATION, text);
  if (confirmation?.[1]) return confirmation[1].trim().toLowerCase();
  const status = EFFORT_STATUS_LINE.exec(text);
  return status?.[1] ? status[1].trim().toLowerCase() : null;
}

function resolveGenericNumberedDialog(
  text: string,
  minimumOptionCount = 2,
): ClaudeUnifiedGenericNumberedDialog | null {
  const lines = text.split('\n');
  const blocks: Array<Array<{ index: number; number: number; label: string; focused: boolean }>> = [];
  let current: Array<{ index: number; number: number; label: string; focused: boolean }> = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const match = NUMBERED_DIALOG_OPTION_LINE.exec(line);
    if (!match?.[1] || !match[2]) {
      if (current.length > 0) blocks.push(current);
      current = [];
      continue;
    }
    current.push({
      index,
      number: Number(match[1]),
      label: match[2].trim(),
      focused: FOCUSED_SELECTION_LINE.test(line),
    });
  }
  if (current.length > 0) blocks.push(current);
  if (blocks.length !== 1) return null;
  const block = blocks[0];
  if (!block || block.length < minimumOptionCount || block.length > 9) return null;
  if (block.filter((candidate) => candidate.focused).length !== 1) return null;
  if (block.some((candidate, index) => candidate.number !== index + 1)) return null;
  if (block.some((candidate) => candidate.label.length < 1 || candidate.label.length > 120)) return null;
  const normalizedLabels = block.map((candidate) => candidate.label.toLocaleLowerCase());
  if (new Set(normalizedLabels).size !== normalizedLabels.length) return null;
  const firstIndex = block[0]?.index ?? -1;
  const context = lines
    .slice(Math.max(0, firstIndex - 4), firstIndex)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-3);
  if (context.length === 0 || context.some((line) => line.length > 160)) return null;
  const signature = JSON.stringify({
    context,
    options: block.map((candidate) => ({ number: candidate.number, label: candidate.label })),
  });
  if (signature.length > 1_024) return null;
  return {
    context,
    options: block.map((candidate) => ({ choice: String(candidate.number), label: candidate.label })),
    signature,
  };
}

export function parseClaudeScreenState(rawText: string, context?: ClaudeScreenParseContext): ClaudeScreenState {
  const text = normalizeCapturedScreen(rawText);
  const visibleTail = tailLines(text, 30);
  const usageLimitDialogCandidate = (
    USAGE_LIMIT_DIALOG.test(visibleTail)
    || CROPPED_USAGE_LIMIT_DIALOG.test(visibleTail)
  )
    ? resolveGenericNumberedDialog(visibleTail, 1)
    : null;
  const visibleNumberedDialog = usageLimitDialogCandidate ?? resolveGenericNumberedDialog(visibleTail);

  const switchModelDialogVisible = SWITCH_MODEL_DIALOG.test(text);
  const usageLimitDialogVisible = usageLimitDialogCandidate !== null;
  const resumeChoiceDialogOptions = resolveResumeChoiceDialogOptions(text);
  const resumeChoiceDialogVisible = resumeChoiceDialogOptions.length > 0;
  const safeguardPauseDialogOptions = resolveSafeguardPauseDialogOptions(text);
  const safeguardPauseDialogVisible = safeguardPauseDialogOptions.length > 0;
  const effortChangeDialogVisible = EFFORT_CHANGE_DIALOG.test(text);
  const effortChangeDialogTarget = effortChangeDialogVisible
    ? (EFFORT_CHANGE_DIALOG_TARGET.exec(text)?.[1]?.toLowerCase() ?? null)
    : null;
  const trustFolderPromptVisible = TRUST_FOLDER_PROMPT.test(text) || TRUST_FOLDER_NUMBERED_CHOICES.test(text);
  const permissionPromptVisible = !trustFolderPromptVisible && PERMISSION_PROMPT.test(text);
  const permissionEditorOpen = PERMISSION_EDITOR.test(text) || PERMISSION_EDITOR_HEADER.test(text);
  const queuedMessageBannerVisible = QUEUED_MESSAGE_BANNER.test(text);
  const generating = ESC_TO_INTERRUPT.test(text) || GENERATING_SPINNER_LINE.test(text) || queuedMessageBannerVisible;

  const composerState = readComposerState(text, rawText, context);
  const composerContent = composerState.content;
  const hasComposer = composerContent !== null;
  // A host cursor on the parsed composer is direct evidence that the composer, not an older
  // selection-shaped transcript row elsewhere in the pane, owns keyboard input. Preserve
  // fail-closed handling when cursor ownership is unavailable or remains on a real chooser.
  const activeComposerOwnsInput = hasComposer && composerState.cursorRelation !== null;
  const composerHasSlash = hasComposer && composerContent.startsWith('/');
  const slashPickerOpen = composerHasSlash && SLASH_SUGGESTION_LINE.test(text);
  const userDraftPresent = hasComposer && composerContent.length > 0 && !composerHasSlash;

  const unrecognizedConfirmationDialogVisible =
    NUMBERED_SELECTION_OPTION.test(text)
    && !activeComposerOwnsInput
    && !switchModelDialogVisible
    && !usageLimitDialogVisible
    && !resumeChoiceDialogVisible
    && !safeguardPauseDialogVisible
    && !effortChangeDialogVisible
    && !trustFolderPromptVisible
    && !permissionPromptVisible
    && !permissionEditorOpen;
  const genericNumberedDialog = unrecognizedConfirmationDialogVisible
    ? resolveGenericNumberedDialog(text)
    : null;

  const anyDialog =
    switchModelDialogVisible
    || usageLimitDialogVisible
    || resumeChoiceDialogVisible
    || safeguardPauseDialogVisible
    || effortChangeDialogVisible
    || unrecognizedConfirmationDialogVisible
    || trustFolderPromptVisible
    || permissionPromptVisible
    || permissionEditorOpen;

  const modeMarker = resolveModeMarker(text);
  const latestEffort = resolveLatestEffortConfirmation(text);

  const inputBoxInteractive =
    !generating
    && !anyDialog
    && (hasComposer || WORK_PROMPT.test(tailLines(text, 10)) || modeMarker !== 'default');

  return {
    text,
    inputBoxInteractive,
    generating,
    slashPickerOpen,
    permissionEditorOpen,
    permissionPromptVisible,
    trustFolderPromptVisible,
    switchModelDialogVisible,
    usageLimitDialogVisible,
    visibleNumberedDialog,
    resumeChoiceDialogVisible,
    resumeChoiceDialogOptions,
    safeguardPauseDialogVisible,
    safeguardPauseDialogOptions,
    effortChangeDialogVisible,
    unrecognizedConfirmationDialogVisible,
    unrecognizedConfirmationDialog: genericNumberedDialog,
    effortChangeDialogTarget,
    latestEffortConfirmation: latestEffort === null ? null : { kind: latestEffort.kind, level: latestEffort.level },
    keptEffortNoticeCount: Array.from(text.matchAll(EFFORT_KEPT_NOTICE)).length,
    queuedMessageBannerVisible,
    userDraftPresent,
    selectionListVisible: SELECTION_CURSOR_ROW.test(text) || (SELECTION_LIST_HINT.test(text) && !hasComposer),
    composerContent,
    composerCursorRelation: composerState.cursorRelation,
    modeMarker,
    visibleModel: resolveVisibleModel(text),
    visibleEffort: resolveVisibleEffort(text),
  };
}

function hasCapturedClaudeComposer(state: ClaudeScreenState): boolean {
  return state.composerContent !== null;
}

function hasClaudeInteractiveComposer(state: ClaudeScreenState): boolean {
  return state.inputBoxInteractive && hasCapturedClaudeComposer(state);
}

function hasBlockingOverlay(state: ClaudeScreenState): boolean {
  return (
    state.generating
    || state.slashPickerOpen
    || (state.composerContent?.startsWith('/') ?? false)
    || state.permissionEditorOpen
    || state.permissionPromptVisible
    || state.trustFolderPromptVisible
    || state.switchModelDialogVisible
    || state.usageLimitDialogVisible
    || state.resumeChoiceDialogVisible
    || state.safeguardPauseDialogVisible
    || state.effortChangeDialogVisible
    || state.unrecognizedConfirmationDialogVisible
    || state.queuedMessageBannerVisible
    || state.userDraftPresent
    || state.selectionListVisible
  );
}

/**
 * Startup-readiness predicate (D15): the TUI shows a captured interactive composer and is NOT
 * generating, blocked by a dialog/editor, showing a slash command picker, or holding a visible
 * user draft. A mode footer alone is not composer readiness while the TUI redraws its transcript.
 *
 * This is the single shared screen-state owner for both startup readiness and runtime-control safe
 * windows (Section A intent), replacing the readiness bridge's narrow standalone regex which missed
 * boxed composers (`│ > │`) and produced false-negative "not ready" detections that killed live hosts.
 */
export function isClaudeScreenReadyForInput(state: ClaudeScreenState): boolean {
  return hasClaudeInteractiveComposer(state) && !hasBlockingOverlay(state);
}

/** Safe to type `/model` / `/effort` and submit only on a clean, interactive composer. */
export function isSafeWindowForSlashControl(state: ClaudeScreenState): boolean {
  return hasClaudeInteractiveComposer(state) && !hasBlockingOverlay(state);
}

/** Safe to send a raw ShiftTab mode-cycle press only on a clean, interactive composer. */
export function isSafeWindowForModeCycle(state: ClaudeScreenState): boolean {
  return hasClaudeInteractiveComposer(state) && !hasBlockingOverlay(state);
}

/**
 * In-flight steer safe-window (D19/D19b): returns the veto reason, or null when the screen is safe
 * to steer a delivered pending prompt. Steering is "inject unless hard-blocked", not "only while
 * generating": while generating, Claude's TUI natively queues typed text and submits it at turn end
 * (probe P-D); on an idle interactive composer, typed text submits as the next message — exactly
 * what a user typing in the attached TUI gets. The queued-message banner does NOT veto: it proves
 * Claude is already queueing typed input. Hard blockers are dialogs/editors/pickers, a visible user
 * draft (text would merge), and screens with no interactive composer at all (unknown/transcript-only
 * /heavy-resume renders) — those fail closed to the deferred path.
 */
export function resolveClaudeScreenInFlightSteerVeto(state: ClaudeScreenState): string | null {
  if (state.permissionPromptVisible) return 'permission_prompt';
  if (state.trustFolderPromptVisible) return 'trust_prompt';
  if (state.switchModelDialogVisible) return 'switch_model_dialog';
  if (state.usageLimitDialogVisible) return 'usage_limit_dialog';
  if (state.resumeChoiceDialogVisible) return 'resume_choice_dialog';
  if (state.safeguardPauseDialogVisible) return 'safeguard_pause_dialog';
  if (state.effortChangeDialogVisible) return 'effort_change_dialog';
  if (state.unrecognizedConfirmationDialogVisible) return 'unrecognized_confirmation_dialog';
  if (state.permissionEditorOpen) return 'permission_editor';
  if (state.slashPickerOpen || (state.composerContent?.startsWith('/') ?? false)) return 'slash_picker';
  if (state.selectionListVisible) return 'selection_list';
  if (state.userDraftPresent) return 'user_draft';
  if (state.generating) return null;
  return hasClaudeInteractiveComposer(state) ? null : 'no_interactive_composer';
}

/**
 * Mode cycling is not text injection. Live Claude TUI evidence shows raw Shift+Tab still cycles
 * permission mode while a permission prompt is visible, which is the escape hatch users need when
 * switching to yolo/bypass to resolve that prompt. Keep every other in-flight steer blocker intact.
 */
export function resolveClaudeScreenModeCycleVeto(state: ClaudeScreenState): string | null {
  if (state.permissionPromptVisible) return null;
  return resolveClaudeScreenInFlightSteerVeto(state);
}
