/**
 * Parsed Claude Unified TUI screen state — the ONE shared screen-state owner for
 * startup readiness, in-flight steer safe-window decisions, and runtime-control
 * (slash-command / mode-cycle) safe windows.
 *
 * Parsing operates on host-captured pane text (tmux `capture-pane -p` / zellij dump);
 * a defensive local normalization strips stray ANSI/control sequences. This is for
 * readiness, steering, and control verification ONLY — never for screen-derived
 * permission approval. Markers are keyed to real Claude Code 2.1.170–2.1.174 probe
 * captures; newer versions add fixtures rather than mutating these in place.
 */

export type ClaudeTuiModeMarker = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions' | 'auto';

export type ClaudeScreenState = Readonly<{
  text: string;
  inputBoxInteractive: boolean;
  generating: boolean;
  slashPickerOpen: boolean;
  permissionEditorOpen: boolean;
  permissionPromptVisible: boolean;
  trustFolderPromptVisible: boolean;
  switchModelDialogVisible: boolean;
  /** `Change effort level?` confirmation dialog (live probe 2.1.173, incident cmq8y3nlx L6). */
  effortChangeDialogVisible: boolean;
  /**
   * A `❯`-numbered selection dialog whose heading matches NO recognized matcher (P-B fail-closed):
   * e.g. a confirmation added by a newer Claude build. Typing answers it and Escape declines it, so
   * controls/steering must fail closed (`requires_interactive_control`) instead of touching it.
   */
  unrecognizedConfirmationDialogVisible: boolean;
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
   * Agents/selection panel that actually OWNS keyboard input: a `❯ ◯ …` focused cursor row, or
   * the `↑/↓ to select` header with NO interactive composer on screen. The hint header alone is
   * NOT enough: while background agents run, Claude renders a PASSIVE tasks footer
   * (`⏺ main … ↑/↓ to select · Enter to view` + unfocused `◯` rows) below a fully interactive
   * composer (remote-dev live incident cmq9x64qc — the hint-only matcher starved steering with
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
  modeMarker: ClaudeTuiModeMarker;
  visibleModel: string | null;
  visibleEffort: string | null;
}>;

const ESC_TO_INTERRUPT = /esc to interrupt/i;
// Real spinner lines do not always carry "esc to interrupt" (remote-dev live capture 2026-06-11:
// `✽ Billowing… (10m 24s · ↓ 20.4k tokens)`). Detect the spinner-line shape: an
// animation glyph, a status word, an ellipsis, then a parenthesized status group. Completion lines
// (`✳ Crunched for 6s`) have no parenthesized group and must NOT match.
const GENERATING_SPINNER_LINE = /(?:^|\n)[^\S\n]*[✶✻✽✳·∗*][^\S\n]+\S+…[^\S\n]*\(/u;
const QUEUED_MESSAGE_BANNER = /press up to edit queued messages/i;
const SWITCH_MODEL_DIALOG = /switch model\?/i;
// Live probe 2026-06-11 (Claude Code 2.1.173, tmux): `/effort <level>` on a conversation cached at a
// different effort opens "Change effort level? … ❯ 1. Yes, switch to <level>  2. No, go back".
// Escape / "No, go back" prints `Kept effort level as <current>` (incident cmq8y3nlx, L6).
const EFFORT_CHANGE_DIALOG = /change effort level\?/i;
// Selection-dialog option shape shared by every observed confirmation dialog (2.1.170 Switch
// model?, 2.1.173 Change effort level?): a `❯` focus glyph directly on a numbered option line.
// Used to fail closed on dialogs we do NOT recognize. Composer prompt echoes (`❯ <prompt>`) only
// match when the prompt itself starts with `<digit>.` — accepted false-positive toward safety.
const NUMBERED_SELECTION_OPTION = /(?:^|\n)[^\S\n]*❯[^\S\n]*\d+\./u;
const EFFORT_CHANGE_DIALOG_TARGET = /switching to\s+([a-z]+)\s+means the full history/i;
const PERMISSION_PROMPT = /do you want to proceed\?/i;
// Legacy wording plus the real 2.1.170 `/permissions` editor tab row
// ("Permissions  Recently denied  Allow  Ask  Deny  Workspace"). The "Recently denied" +
// "Deny" tab pair is unique to the editor and never appears together in normal output.
const PERMISSION_EDITOR = /\bpermission rules\b/i;
const PERMISSION_EDITOR_HEADER = /\brecently denied\b[^\n]*\bdeny\b/i;
const TRUST_FOLDER_PROMPT = /do you trust the files in this folder\?/i;
const WORK_PROMPT = /what would you like to work on\?/i;

const ACCEPT_EDITS_MARKER = /\baccept edits on\b/i;
const PLAN_MODE_MARKER = /\bplan mode on\b/i;
const AUTO_MODE_MARKER = /\bauto(?: mode)? on\b/i;
const BYPASS_MARKER = /\bbypass permissions on\b/i;

// `[1m]`-tolerant: the echo carries whatever id was typed, suffix included.
const MODEL_CONFIRMATION = /set model to\s+(.+?)(?:\s+and saved\b|\s*$)/im;
const MODEL_STATUS_LINE = /\bmodel:\s*([^\n]+?)\s*$/im;
// Real 2.1.170 text is "Set effort level to <x>" (including `ultracode`); older builds
// said "Set reasoning effort to <x>".
const EFFORT_CONFIRMATION = /set (?:reasoning )?effort (?:level )?to\s+([a-z]+)\b/gim;
const EFFORT_KEPT_NOTICE = /kept effort level as\s+([a-z]+)\b/gim;
const EFFORT_STATUS_LINE = /\beffort:\s*([a-z]+)\b/im;

// Composer prompt line: `>`, `›` (U+203A), or `❯` (U+276F, the real 2.1.170 glyph)
// followed by optional content (inside an optional box border). The negative lookahead
// excludes menu-selection lines (`❯ 1. Yes`) — the same `❯` glyph marks dialog choices —
// so a dialog never reads as an interactive composer (fail-closed: an ambiguous numbered
// line is treated as not-a-composer).
const COMPOSER_LINE = /(?:^|\n)[^\S\n]*(?:[│|][^\S\n]*)?(?:>|›|❯)(?![^\S\n]*(?:\d+\.|[◯◉○●◐◑]))[^\S\n]*(.*?)[^\S\n]*(?:[│|][^\S\n]*)?(?:\n|$)/;
const SLASH_SUGGESTION_LINE = /(?:^|\n)[^\S\n]*\/[a-z][a-z0-9-]*\b/i;
// Empty-composer placeholder hint family (live capture 2026-06-12, Claude Code 2.1.174 fresh spawn:
// `❯ Try "refactor <filepath>"`). The placeholder renders ONLY while the composer is empty, so it
// must read as an empty composer — parsing it as a user draft starved startup readiness/controls
// forever and killed fresh-dir session creation. Legacy builds used the "What would you like to
// work on?" banner (WORK_PROMPT) instead. Quote-wrapped only: real typed text such as
// `Try harder on the parser fix` must stay a draft (fail-closed).
const COMPOSER_PLACEHOLDER_HINT = /^Try\s+["“][^"”]*["”]$/;
// Agents/selection panel (remote-dev live capture 2026-06-12): the selector header renders
// `↑/↓ to select` and the focus cursor renders as `❯ ◯ <agent-type> <title>` rows. The cursor
// row must never read as a composer draft (false `user_draft` steer veto with a misleading
// "clear the draft" notice), and typing/Enter on a focused selector drives the SELECTOR, so it
// is a blocking overlay for controls and steering.
const SELECTION_LIST_HINT = /↑\/↓ to select/;
const SELECTION_CURSOR_ROW = /(?:^|\n)[^\S\n]*❯[^\S\n]*[◯◉○●◐◑]/;

// eslint-disable-next-line no-control-regex
const ANSI_SEQUENCE = /\u001B\[[0-9;?]*[ -/]*[@-~]|\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)?/gu;

/** Defensive normalization: strip ANSI/control noise and normalize line endings. */
export function normalizeClaudeCapturedScreen(rawText: string): string {
  return rawText
    .replace(ANSI_SEQUENCE, '')
    .replace(/\r\n?/gu, '\n')
    .split('\n')
    .map((line) => line.replace(/[^\S\n]+$/gu, ''))
    .join('\n');
}

function tailLines(text: string, count: number): string {
  return text.split('\n').slice(-count).join('\n');
}

function lastMatch(pattern: RegExp, text: string): RegExpExecArray | null {
  let last: RegExpExecArray | null = null;
  for (const match of text.matchAll(pattern)) last = match as RegExpExecArray;
  return last;
}

// Composer-box bottom border / horizontal rule (also matches box corners ╰╭ and heavy rules).
const COMPOSER_BORDER_LINE = /^[\s─━—╰╯╭╮│|]*$/;
// Status glyphs that can follow the composer when no border is rendered (fail-closed stop set).
const COMPOSER_CONTINUATION_STOP = /^[\s]*(?:[⏵←⏺✻✶·]|⚠)/;

/**
 * Continuation lines of a soft-wrapped composer draft (remote-dev C11 live capture): a draft
 * longer than the pane width wraps onto indented lines inside the composer box. Capturing only
 * the `❯` line truncated the draft, so an own-injected leftover could never exact-match the
 * own-text registry. Continuation = indented, non-border, non-status lines between the composer
 * line and the box bottom border.
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
    if (!/^[^\S\n]/.test(line)) break;
    const trimmed = line.trim();
    if (trimmed.length === 0) break;
    continuation.push(trimmed);
  }
  return continuation;
}

// SGR (Select Graphic Rendition) sequence prefix: ESC [ <params> m. Only SGR affects the dim
// state; other CSI/OSC sequences are skipped by the styled-line walker below.
const SGR_SEQUENCE_PREFIX = '\u001b[';

/**
 * Walk one RAW (ANSI-bearing) screen line and return its visible characters annotated with the
 * SGR dim (faint, code 2) state active at each character. Codes 0/empty and 22 clear dim.
 */
function readStyledLineRuns(rawLine: string): ReadonlyArray<Readonly<{ char: string; dim: boolean }>> {
  const runs: Array<Readonly<{ char: string; dim: boolean }>> = [];
  let dim = false;
  let index = 0;
  while (index < rawLine.length) {
    if (rawLine.startsWith(SGR_SEQUENCE_PREFIX, index)) {
      const end = rawLine.indexOf('m', index + 2);
      const body = end === -1 ? null : rawLine.slice(index + 2, end);
      if (body !== null && /^[0-9;]*$/.test(body)) {
        for (const code of (body.length === 0 ? '0' : body).split(';')) {
          if (code === '' || code === '0') dim = false;
          else if (code === '2') dim = true;
          else if (code === '22') dim = false;
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
    runs.push({ char: rawLine[index], dim });
    index += 1;
  }
  return runs;
}

/**
 * Claude Code renders empty-composer placeholder/suggestion text DIM (SGR 2) — remote-dev live
 * capture, 2.1.174 zellij `dump-screen --ansi`: `❯ \x1b[2m\x1b[23mcheck the output`. The
 * contextual-suggestion family has arbitrary wording (no `Try "<hint>"` quoting), so styling is
 * the only honest discriminator from a real typed draft (which renders at normal intensity).
 * Fail-closed: without styling information (plain capture) the text stays a draft.
 */
function composerContentIsDimPlaceholder(rawText: string, content: string): boolean {
  if (content.length === 0) return false;
  if (!rawText.includes(SGR_SEQUENCE_PREFIX)) return false;
  const rawLines = rawText.replace(/\r\n?/gu, '\n').split('\n');
  for (let lineIndex = rawLines.length - 1; lineIndex >= 0; lineIndex -= 1) {
    const rawLine = rawLines[lineIndex];
    const stripped = rawLine.replace(ANSI_SEQUENCE, '');
    if (!stripped.includes(content)) continue;
    // Only composer-shaped lines qualify; transcript echoes are handled identically (bottom-most
    // matching line wins, mirroring lastMatch over the normalized text).
    if (!/[>›❯]/.test(stripped)) continue;
    const runs = readStyledLineRuns(rawLine);
    const visible = runs.map((run) => run.char).join('');
    const start = visible.lastIndexOf(content);
    if (start === -1) return false;
    for (let i = start; i < start + content.length; i += 1) {
      if (!runs[i].dim) return false;
    }
    return true;
  }
  return false;
}

function readComposerContent(text: string, rawText: string): string | null {
  // Executed prompts echo as `❯ <prompt>` transcript rows (live capture 2026-06-11); the REAL
  // composer is the LAST composer-shaped line on screen (the input box renders at the bottom).
  const match = lastMatch(new RegExp(COMPOSER_LINE.source, `${COMPOSER_LINE.flags}g`), text);
  if (!match) return null;
  const content = (match[1] ?? '').trim();
  if (COMPOSER_PLACEHOLDER_HINT.test(content)) return '';
  if (content.length === 0) return content;
  const continuation = readComposerContinuationLines(text, match.index + match[0].length);
  if (continuation.length === 0 && composerContentIsDimPlaceholder(rawText, content)) return '';
  return continuation.length === 0 ? content : [content, ...continuation].join('\n');
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

type EffortConfirmationSignal = Readonly<{ kind: 'set' | 'kept'; level: string; index: number }>;

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

export function parseClaudeScreenState(rawText: string): ClaudeScreenState {
  const text = normalizeClaudeCapturedScreen(rawText);

  const switchModelDialogVisible = SWITCH_MODEL_DIALOG.test(text);
  const effortChangeDialogVisible = EFFORT_CHANGE_DIALOG.test(text);
  const effortChangeDialogTarget = effortChangeDialogVisible
    ? (EFFORT_CHANGE_DIALOG_TARGET.exec(text)?.[1]?.toLowerCase() ?? null)
    : null;
  const trustFolderPromptVisible = TRUST_FOLDER_PROMPT.test(text);
  const permissionPromptVisible = !trustFolderPromptVisible && PERMISSION_PROMPT.test(text);
  const permissionEditorOpen = PERMISSION_EDITOR.test(text) || PERMISSION_EDITOR_HEADER.test(text);
  const queuedMessageBannerVisible = QUEUED_MESSAGE_BANNER.test(text);
  const generating = ESC_TO_INTERRUPT.test(text) || GENERATING_SPINNER_LINE.test(text) || queuedMessageBannerVisible;

  const composerContent = readComposerContent(text, rawText);
  const hasComposer = composerContent !== null;
  const composerHasSlash = hasComposer && composerContent.startsWith('/');
  const slashPickerOpen = composerHasSlash && SLASH_SUGGESTION_LINE.test(text);
  const userDraftPresent = hasComposer && composerContent.length > 0 && !composerHasSlash;

  const unrecognizedConfirmationDialogVisible =
    NUMBERED_SELECTION_OPTION.test(text)
    && !switchModelDialogVisible
    && !effortChangeDialogVisible
    && !trustFolderPromptVisible
    && !permissionPromptVisible
    && !permissionEditorOpen;

  const anyDialog =
    switchModelDialogVisible
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
    effortChangeDialogVisible,
    unrecognizedConfirmationDialogVisible,
    effortChangeDialogTarget,
    latestEffortConfirmation: latestEffort === null ? null : { kind: latestEffort.kind, level: latestEffort.level },
    keptEffortNoticeCount: Array.from(text.matchAll(EFFORT_KEPT_NOTICE)).length,
    queuedMessageBannerVisible,
    userDraftPresent,
    selectionListVisible: SELECTION_CURSOR_ROW.test(text) || (SELECTION_LIST_HINT.test(text) && !hasComposer),
    composerContent,
    modeMarker,
    visibleModel: resolveVisibleModel(text),
    visibleEffort: resolveVisibleEffort(text),
  };
}

function hasBlockingOverlay(state: ClaudeScreenState): boolean {
  return (
    state.generating
    || state.slashPickerOpen
    || state.permissionEditorOpen
    || state.permissionPromptVisible
    || state.trustFolderPromptVisible
    || state.switchModelDialogVisible
    || state.effortChangeDialogVisible
    || state.unrecognizedConfirmationDialogVisible
    || state.queuedMessageBannerVisible
    || state.userDraftPresent
    || state.selectionListVisible
  );
}

/**
 * Startup/idle readiness predicate: the TUI shows an interactive input box and is NOT
 * generating, blocked by a dialog/editor, showing a slash command picker, or holding a
 * visible user draft. This replaces narrow standalone regexes that missed boxed
 * composers (`│ > │`) and produced false-negative "not ready" detections.
 */
export function isClaudeScreenReadyForInput(state: ClaudeScreenState): boolean {
  return state.inputBoxInteractive && !hasBlockingOverlay(state);
}

/** Safe to type `/model` / `/effort` and submit only on a clean, interactive composer. */
export function isSafeWindowForSlashControl(state: ClaudeScreenState): boolean {
  return state.inputBoxInteractive && !hasBlockingOverlay(state);
}

/** Safe to send a raw ShiftTab mode-cycle press only on a clean, interactive composer. */
export function isSafeWindowForModeCycle(state: ClaudeScreenState): boolean {
  return state.inputBoxInteractive && !hasBlockingOverlay(state);
}

/**
 * In-flight steer safe-window: returns the veto reason, or null when the screen is safe
 * to steer a delivered pending prompt (D19b: "inject unless hard-blocked", not "only while
 * generating"). While generating, Claude's TUI natively queues typed text and submits it at
 * turn end; on an idle interactive composer, typed text submits as the next message — exactly
 * what a user typing in the attached TUI gets. The queued-message banner does NOT veto: it
 * proves Claude is already queueing typed input. Hard blockers are dialogs/editors/pickers, a
 * visible user draft, and screens with no interactive composer at all (unknown/transcript-only
 * /heavy-resume renders) — those fail closed to the deferred path.
 */
export function resolveClaudeScreenInFlightSteerVeto(state: ClaudeScreenState): string | null {
  if (state.permissionPromptVisible) return 'permission_prompt';
  if (state.trustFolderPromptVisible) return 'trust_prompt';
  if (state.switchModelDialogVisible) return 'switch_model_dialog';
  if (state.effortChangeDialogVisible) return 'effort_change_dialog';
  if (state.unrecognizedConfirmationDialogVisible) return 'unrecognized_confirmation_dialog';
  if (state.permissionEditorOpen) return 'permission_editor';
  if (state.slashPickerOpen) return 'slash_picker';
  if (state.selectionListVisible) return 'selection_list';
  if (state.userDraftPresent) return 'user_draft';
  if (state.generating) return null;
  if (state.inputBoxInteractive) return null;
  return 'no_interactive_composer';
}
