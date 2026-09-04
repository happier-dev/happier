import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  isClaudeScreenReadyForInput,
  isSafeWindowForModeCycle,
  isSafeWindowForSlashControl,
  parseClaudeScreenState,
  resolveClaudeScreenInFlightSteerVeto,
} from './screenState';

const CLAUDE_2_1_228_USAGE_LIMIT_DIALOG = [
  "You've hit your session limit · resets 2:40am (Europe/Zurich)",
  '',
  'What do you want to do?',
  '❯ 1. Stop and wait for limit to reset',
  '  2. Switch to usage credits',
  '  3. Switch to Team plan',
  '',
  'Enter to confirm · Esc to cancel',
].join('\n');

const CROPPED_SINGLE_OPTION_USAGE_LIMIT_DIALOG = [
  'What do you want to do?',
  '❯ 1. Stop and wait for limit to reset',
  '',
  'Enter to confirm · Esc to cancel',
].join('\n');

const CLAUDE_2_1_259_HIDDEN_INDEX_TRUST_DIALOG = [
  'Accessing workspace:',
  '/tmp/happier-claude-dialog-probe',
  '',
  'Quick safety check: Is this a project you created or one you trust?',
  '',
  '❯ No, exit',
  '  Yes, I trust this folder',
  '',
  'Enter to confirm · Esc to cancel',
].join('\n');

/**
 * Fixtures are derived from the live probe captures documented in
 * `.reviews/20260610-claude-unified-independent-audit/probes/probe-log.md` (Claude Code 2.1.170, tmux).
 * Markers: `⏵⏵ accept edits on`, `⏸ plan mode on`, `⏵⏵ auto mode on`, `Switch model?` dialog,
 * `Press up to edit queued messages` banner, `Set model to … saved as your default` confirmation.
 */
const CLAUDE_2_1_170 = {
  idleDefault: [
    '',
    ' What would you like to work on?',
    '',
    '╭───────────────────────────────────────────────╮',
    '│ >                                               │',
    '╰───────────────────────────────────────────────╯',
    '  ? for shortcuts',
  ].join('\n'),
  idleAcceptEdits: [
    '╭───────────────────────────────────────────────╮',
    '│ >                                               │',
    '╰───────────────────────────────────────────────╯',
    '  ⏵⏵ accept edits on (shift+tab to cycle)',
  ].join('\n'),
  idlePlan: [
    '╭───────────────────────────────────────────────╮',
    '│ >                                               │',
    '╰───────────────────────────────────────────────╯',
    '  ⏸ plan mode on (shift+tab to cycle)',
  ].join('\n'),
  idleAuto: [
    '╭───────────────────────────────────────────────╮',
    '│ >                                               │',
    '╰───────────────────────────────────────────────╯',
    '  ⏵⏵ auto mode on (shift+tab to cycle)',
  ].join('\n'),
  generating: [
    '● Counting to thirty…',
    '  1 2 3 4 5',
    '',
    '✶ Forging… (12s · esc to interrupt)',
  ].join('\n'),
  queuedMessageWhileGenerating: [
    '● Counting to thirty…',
    '✶ Forging… (14s · esc to interrupt)',
    '',
    '  ▐ /model claude-haiku-4-5-20251001',
    '  Press up to edit queued messages',
  ].join('\n'),
  switchModelDialog: [
    'Switch model?',
    'Reading from cache may produce different results.',
    '',
    '❯ 1. Yes, switch',
    '  2. No, go back',
  ].join('\n'),
  modelConfirmation: [
    '╭───────────────────────────────────────────────╮',
    '│ >                                               │',
    '╰───────────────────────────────────────────────╯',
    'Set model to Sonnet 4.6 and saved as your default for new sessions',
    '  ⏵⏵ accept edits on (shift+tab to cycle)',
  ].join('\n'),
  permissionPrompt: [
    'Bash(curl http://localhost/a)',
    '',
    'Do you want to proceed?',
    '❯ 1. Yes',
    '  2. Yes, and don’t ask again',
    '  3. No, tell Claude what to do differently',
  ].join('\n'),
  permissionsEditor: [
    'Permission rules',
    'Manage allow and deny rules for tools.',
    '',
    '  Allow  Bash(ls:*)',
    '  Deny   Bash(rm:*)',
  ].join('\n'),
  trustFolderPrompt: [
    'Do you trust the files in this folder?',
    '❯ 1. Yes, proceed',
    '  2. No, exit',
  ].join('\n'),
  slashPicker: [
    '╭───────────────────────────────────────────────╮',
    '│ > /mod                                          │',
    '╰───────────────────────────────────────────────╯',
    '  /model     Change the model for this session',
    '  /mcp       Manage MCP servers',
  ].join('\n'),
  userDraft: [
    '╭───────────────────────────────────────────────╮',
    '│ > please refactor the parser before we ship     │',
    '╰───────────────────────────────────────────────╯',
    '  ? for shortcuts',
  ].join('\n'),
} as const;

describe('parseClaudeScreenState — usage-limit chooser', () => {
  it('recognizes the current chooser without pinning its paid alternatives', () => {
    const state = parseClaudeScreenState(CLAUDE_2_1_228_USAGE_LIMIT_DIALOG);

    expect(state.usageLimitDialogVisible).toBe(true);
    expect(state.unrecognizedConfirmationDialogVisible).toBe(false);
    expect(resolveClaudeScreenInFlightSteerVeto(state)).toBe('usage_limit_dialog');

    const changedAlternatives = parseClaudeScreenState(
      CLAUDE_2_1_228_USAGE_LIMIT_DIALOG
        .replace('Switch to usage credits', 'Use another billing source')
        .replace('Switch to Team plan', 'Choose an organization plan'),
    );
    expect(changedAlternatives.usageLimitDialogVisible).toBe(true);

    const changedWaitLabel = parseClaudeScreenState(
      CLAUDE_2_1_228_USAGE_LIMIT_DIALOG.replace(
        'Stop and wait for limit to reset',
        'Wait until your session limit resets',
      ),
    );
    expect(changedWaitLabel.usageLimitDialogVisible).toBe(true);

    const changedHeading = parseClaudeScreenState(
      CLAUDE_2_1_228_USAGE_LIMIT_DIALOG.replace(
        "You've hit your session limit",
        'You have reached your usage limit',
      ),
    );
    expect(changedHeading.usageLimitDialogVisible).toBe(true);
  });

  it('does not mistake an unrelated numbered chooser for a usage-limit dialog', () => {
    const state = parseClaudeScreenState([
      'What do you want to do?',
      '❯ 1. Stop and wait for the build to finish',
      '  2. Cancel the build',
    ].join('\n'));

    expect(state.usageLimitDialogVisible).toBe(false);
    expect(state.unrecognizedConfirmationDialogVisible).toBe(true);
  });

  it('recognizes the cropped one-choice usage-limit chooser from the live terminal viewport', () => {
    const state = parseClaudeScreenState(CROPPED_SINGLE_OPTION_USAGE_LIMIT_DIALOG);

    expect(state.usageLimitDialogVisible).toBe(true);
    expect(state.unrecognizedConfirmationDialogVisible).toBe(false);
    expect(state.visibleNumberedDialog?.options).toEqual([
      { choice: '1', label: 'Stop and wait for limit to reset' },
    ]);
    expect(resolveClaudeScreenInFlightSteerVeto(state)).toBe('usage_limit_dialog');
  });
});

describe('parseClaudeScreenState — mode markers (default by absence)', () => {
  it('detects default mode by the absence of any cycle marker', () => {
    const state = parseClaudeScreenState(CLAUDE_2_1_170.idleDefault);
    expect(state.modeMarker).toBe('default');
    expect(state.inputBoxInteractive).toBe(true);
    expect(state.generating).toBe(false);
  });

  it('detects accept edits, plan, and auto markers', () => {
    expect(parseClaudeScreenState(CLAUDE_2_1_170.idleAcceptEdits).modeMarker).toBe('acceptEdits');
    expect(parseClaudeScreenState(CLAUDE_2_1_170.idlePlan).modeMarker).toBe('plan');
    expect(parseClaudeScreenState(CLAUDE_2_1_170.idleAuto).modeMarker).toBe('auto');
  });
});

describe('parseClaudeScreenState — generation and queued banners', () => {
  it('detects active generation via the esc-to-interrupt marker', () => {
    const state = parseClaudeScreenState(CLAUDE_2_1_170.generating);
    expect(state.generating).toBe(true);
    expect(state.inputBoxInteractive).toBe(false);
  });

  // Live capture 2026-06-11 (zellij, incident cmq8y3nlx steering vetoes): the real spinner line can
  // omit "esc to interrupt" entirely (`✽ Billowing… (10m 24s · ↓ 20.4k tokens)`), and the composer
  // stays visible below it. Generating must be detected from the spinner-line shape itself.
  it('detects generation from a real spinner line WITHOUT the esc-to-interrupt suffix', () => {
    const liveCapture = [
      '⏺ Agent "Research FlashList v2 known issues"',
      'completed · 9m 35s',
      '     (ctrl+b to run in background)',
      '',
      '✽ Billowing… (10m 24s · ↓ 20.4k tokens)',
      '  ⎿  Tip: Use /btw to ask a quick side question',
      '     without interrupting Claude’s current work',
      '',
      '────────────────────────────────────────────────',
      '❯ ',
      '────────────────────────────────────────────────',
      '',
      '  ⏵⏵ auto mode on (shift+tab to cycle)',
    ].join('\n');
    const state = parseClaudeScreenState(liveCapture);
    expect(state.generating).toBe(true);
    expect(isSafeWindowForSlashControl(state)).toBe(false);
  });

  it('does not mistake a completion line (no parens) for generation', () => {
    const state = parseClaudeScreenState('✻ Crunched for 6s\n╭───╮\n│ ❯   │\n╰───╯');
    expect(state.generating).toBe(false);
  });

  it('detects the queued-message banner shown when a slash command is typed mid-generation', () => {
    const state = parseClaudeScreenState(CLAUDE_2_1_170.queuedMessageWhileGenerating);
    expect(state.queuedMessageBannerVisible).toBe(true);
    expect(state.generating).toBe(true);
  });
});

describe('parseClaudeScreenState — dialogs and editors', () => {
  it('detects the Switch model? confirmation dialog', () => {
    const state = parseClaudeScreenState(CLAUDE_2_1_170.switchModelDialog);
    expect(state.switchModelDialogVisible).toBe(true);
  });

  it('detects the native permission prompt', () => {
    const state = parseClaudeScreenState(CLAUDE_2_1_170.permissionPrompt);
    expect(state.permissionPromptVisible).toBe(true);
  });

  it('recognizes the /permissions editor screen (veto target, never a mode setter)', () => {
    const state = parseClaudeScreenState(CLAUDE_2_1_170.permissionsEditor);
    expect(state.permissionEditorOpen).toBe(true);
  });

  it('detects the trust-folder prompt', () => {
    const state = parseClaudeScreenState(CLAUDE_2_1_170.trustFolderPrompt);
    expect(state.trustFolderPromptVisible).toBe(true);
  });

  it('recognizes the Claude 2.1.259 hidden-index trust chooser as a dialog, never a user draft', () => {
    const state = parseClaudeScreenState(CLAUDE_2_1_259_HIDDEN_INDEX_TRUST_DIALOG);

    expect(state.trustFolderPromptVisible).toBe(true);
    expect(state.inputBoxInteractive).toBe(false);
    expect(state.userDraftPresent).toBe(false);
    expect(state.visibleDialogSelection).toEqual({
      kind: 'focused',
      options: [
        { label: 'No, exit', focused: true },
        { label: 'Yes, I trust this folder', focused: false },
      ],
    });
  });

  it.each([
    ['switch model', [
      'Switch model?',
      '',
      '❯ No, go back',
      '  Yes, switch',
      '',
      'Enter to confirm · Esc to cancel',
    ], 'switchModelDialogVisible'],
    ['effort change', [
      'Change effort level?',
      'Switching to high means the full history gets re-read before Claude can continue.',
      '',
      '❯ No, go back',
      '  Yes, switch to high',
      '',
      'Enter to confirm · Esc to cancel',
    ], 'effortChangeDialogVisible'],
    ['resume choice', [
      'This session is 18h old and 560.4k tokens.',
      '',
      '❯ Resume from summary (recommended)',
      '  Resume full session as-is',
      '  Don’t ask me again',
      '',
      'Enter to confirm · Esc to cancel',
    ], 'resumeChoiceDialogVisible'],
    ['safeguard pause', [
      'Session paused',
      'Fable 5\'s safeguards flagged this message.',
      '',
      '❯ Switch to Opus 4.8',
      '  Edit prompt and retry with Fable 5',
      '',
      'Enter to confirm · Esc to cancel',
    ], 'safeguardPauseDialogVisible'],
    ['usage limit', [
      "You've hit your session limit · resets 2:40am (Europe/Zurich)",
      'What do you want to do?',
      '',
      '❯ Stop and wait for limit to reset',
      '  Switch to usage credits',
      '',
      'Enter to confirm · Esc to cancel',
    ], 'usageLimitDialogVisible'],
  ] as const)('recognizes a hidden-index %s chooser from its semantics and presentation', (_name, lines, key) => {
    const state = parseClaudeScreenState(lines.join('\n'));

    expect(state[key]).toBe(true);
    expect(state.visibleDialogSelection?.kind).toBe('focused');
    expect(state.userDraftPresent).toBe(false);
  });

  it('surfaces an unknown hidden-index chooser as a generic choice instead of a composer draft', () => {
    const state = parseClaudeScreenState([
      'Use the experimental cache?',
      '',
      '❯ No, keep current behavior',
      '  Yes, enable it',
      '',
      'Enter to confirm · Esc to cancel',
    ].join('\n'));

    expect(state.unrecognizedConfirmationDialogVisible).toBe(true);
    expect(state.unrecognizedConfirmationDialog?.options).toEqual([
      { choice: 'option_1', label: 'No, keep current behavior' },
      { choice: 'option_2', label: 'Yes, enable it' },
    ]);
    expect(state.userDraftPresent).toBe(false);
  });

  it('detects the slash command picker', () => {
    const state = parseClaudeScreenState(CLAUDE_2_1_170.slashPicker);
    expect(state.slashPickerOpen).toBe(true);
  });

  it('detects a visible user draft in the composer', () => {
    const state = parseClaudeScreenState(CLAUDE_2_1_170.userDraft);
    expect(state.userDraftPresent).toBe(true);
  });
});

// Live runner capture 2026-06-12 (Claude Code 2.1.174, zellij, fresh-dir spawn pid-45964): the
// EMPTY composer renders a rotating `Try "<hint>"` placeholder before the first message. Parsing
// it as a user draft starved startup readiness forever and killed fresh-dir session creation
// (QA-C funnel finding; see qa/QA-B.md F4).
const CLAUDE_2_1_174_FRESH_PLACEHOLDER = [
  ' ⚠ 1 setup issue: statusline · /doctor',
  '',
  ' ▎ Fable 5 is here! Our newest model for',
  ' ▎ complex, long-running work.',
  '',
  '────────────────────────────────────────────────',
  '❯ Try "refactor <filepath>"',
  '────────────────────────────────────────────────',
  '',
  '  ← for agents',
].join('\n');

describe('parseClaudeScreenState — empty-composer placeholder hint (2.1.174 fresh session)', () => {
  it('keeps the Try "<hint>" text fail-closed as a draft without style or cursor evidence', () => {
    const state = parseClaudeScreenState(CLAUDE_2_1_174_FRESH_PLACEHOLDER);
    expect(state.composerContent).toBe('Try "refactor <filepath>"');
    expect(state.userDraftPresent).toBe(true);
  });

  it('treats the Try "<hint>" placeholder as an EMPTY composer when cursor proves the input is empty', () => {
    const state = parseClaudeScreenState(CLAUDE_2_1_174_FRESH_PLACEHOLDER, {
      cursor: { x: 2, y: 6 },
    });
    expect(state.composerContent).toBe('');
    expect(state.userDraftPresent).toBe(false);
    expect(isClaudeScreenReadyForInput(state)).toBe(true);
    expect(isSafeWindowForSlashControl(state)).toBe(true);
    expect(resolveClaudeScreenInFlightSteerVeto(state)).toBeNull();
  });

  it('treats a segmented dim placeholder as an EMPTY composer even when spaces reset styling', () => {
    const segmentedDim = CLAUDE_2_1_174_FRESH_PLACEHOLDER.replace(
      '❯ Try "refactor <filepath>"',
      '❯ \x1b[2mstart\x1b[0m \x1b[2mthe\x1b[0m \x1b[2mdev\x1b[0m \x1b[2mserver\x1b[0m \x1b[2mso\x1b[0m \x1b[2mI\x1b[0m \x1b[2mcan\x1b[0m \x1b[2msee\x1b[0m \x1b[2mit\x1b[0m',
    );
    const state = parseClaudeScreenState(segmentedDim, { cursor: { x: 2, y: 6 } });
    expect(state.composerContent).toBe('');
    expect(state.userDraftPresent).toBe(false);
    expect(resolveClaudeScreenInFlightSteerVeto(state)).toBeNull();
  });

  it('still treats REAL typed text starting with Try but not quote-wrapped as a draft', () => {
    const typed = CLAUDE_2_1_174_FRESH_PLACEHOLDER.replace(
      '❯ Try "refactor <filepath>"',
      '❯ Try harder on the parser fix',
    );
    const state = parseClaudeScreenState(typed);
    expect(state.userDraftPresent).toBe(true);
  });

  it('treats the typographic-quote placeholder variant as empty when cursor proves it', () => {
    const curly = CLAUDE_2_1_174_FRESH_PLACEHOLDER.replace(
      '❯ Try "refactor <filepath>"',
      '❯ Try “fix typecheck errors”',
    );
    const state = parseClaudeScreenState(curly, { cursor: { x: 2, y: 6 } });
    expect(state.userDraftPresent).toBe(false);
    expect(state.composerContent).toBe('');
  });
});

// Live runner capture 2026-06-12 (Claude Code 2.1.174, zellij `dump-screen --ansi`, runner
// pid 56672): after a background command completes, the EMPTY composer renders a rotating
// CONTEXTUAL suggestion (`❯ check the output`) with arbitrary text — no `Try "<hint>"` quoting —
// so the only honest discriminator is the DIM (SGR 2) styling Claude Code uses for placeholder
// text. Parsing it as a user draft blocked every pending injection forever (QA-B F6).
const ESC = String.fromCharCode(0x1b);
const CLAUDE_2_1_174_DIM_SUGGESTION_ANSI = [
  `${ESC}[m⏺ Background command "Run sleep and echo command`,
  'in background" completed (exit code 0)',
  '',
  '⏺ B2-ok',
  '',
  `${ESC}[38;2;136;136;136m────────────────────────────────────────────────${ESC}[m`,
  // Exact live byte shape: reset, glyph, NBSP, SGR resets, then DIM (2) before the hint text.
  `${ESC}[m❯ ${ESC}[39m${ESC}[49m${ESC}[29m${ESC}[28m${ESC}[27m${ESC}[25m${ESC}[25m${ESC}[22m${ESC}[24m${ESC}[2m${ESC}[23mcheck the output`,
  `${ESC}[38;2;136;136;136m────────────────────────────────────────────────${ESC}[m`,
  '',
  '  ⏵⏵ accept edits on (shift+tab to cycle)',
].join('\n');

describe('parseClaudeScreenState — dim contextual suggestion placeholder (2.1.174, ANSI capture)', () => {
  it('treats DIM-styled composer text as an EMPTY composer, not a user draft', () => {
    const state = parseClaudeScreenState(CLAUDE_2_1_174_DIM_SUGGESTION_ANSI);
    expect(state.composerContent).toBe('');
    expect(state.userDraftPresent).toBe(false);
  });

  it('keeps the dim-suggestion screen ready for input and safe for controls/steering', () => {
    const state = parseClaudeScreenState(CLAUDE_2_1_174_DIM_SUGGESTION_ANSI);
    expect(isClaudeScreenReadyForInput(state)).toBe(true);
    expect(isSafeWindowForSlashControl(state)).toBe(true);
    expect(resolveClaudeScreenInFlightSteerVeto(state)).toBeNull();
  });

  it('keeps NON-dim composer text a draft even when other lines carry styling', () => {
    const typed = CLAUDE_2_1_174_DIM_SUGGESTION_ANSI.replace(
      `${ESC}[2m${ESC}[23mcheck the output`,
      `${ESC}[22m${ESC}[23mcheck the output`,
    );
    const state = parseClaudeScreenState(typed);
    expect(state.userDraftPresent).toBe(true);
    expect(state.composerContent).toBe('check the output');
  });

  it('keeps un-styled captures fail-closed: same text without ANSI stays a draft', () => {
    const plain = [
      '⏺ B2-ok',
      '',
      '────────────────────────────────────────────────',
      '❯ check the output',
      '────────────────────────────────────────────────',
    ].join('\n');
    const state = parseClaudeScreenState(plain);
    expect(state.userDraftPresent).toBe(true);
  });

  it('a dim SGR cancelled by 22 before the content does not read as placeholder', () => {
    const cancelled = CLAUDE_2_1_174_DIM_SUGGESTION_ANSI.replace(
      `${ESC}[2m${ESC}[23mcheck the output`,
      `${ESC}[2m${ESC}[22mcheck the output`,
    );
    const state = parseClaudeScreenState(cancelled);
    expect(state.userDraftPresent).toBe(true);
  });
});

// Live read-only tmux capture from runner pid 98095, Claude Code 2.1.217. The empty composer
// suggestion uses DIM styling except for the first character under the real cursor, which is
// inverse-video. The visible text is provider chrome, not a user-authored draft.
const CLAUDE_2_1_217_CURSOR_HIGHLIGHTED_SUGGESTION = readFileSync(
  new URL('./__fixtures__/incident-98095-contextual-suggestion.ansi', import.meta.url),
  'utf8',
);

describe('parseClaudeScreenState — cursor-highlighted contextual suggestion (2.1.217, tmux)', () => {
  it('treats the mixed inverse-cursor plus dim suggestion as an EMPTY composer', () => {
    const state = parseClaudeScreenState(CLAUDE_2_1_217_CURSOR_HIGHLIGHTED_SUGGESTION, {
      cursor: { x: 2, y: 3 },
    });

    expect(state.composerContent).toBe('');
    expect(state.userDraftPresent).toBe(false);
    expect(isClaudeScreenReadyForInput(state)).toBe(true);
    expect(resolveClaudeScreenInFlightSteerVeto(state)).toBeNull();
  });

  it('keeps the same visible text as a real draft when it is normal intensity and the cursor is after it', () => {
    const typed = CLAUDE_2_1_217_CURSOR_HIGHLIGHTED_SUGGESTION.replace(
      `${ESC}[7mc${ESC}[0;2mommit this${ESC}[0m`,
      `${ESC}[38;2;255;255;255mcommit this${ESC}[0m`,
    );
    const state = parseClaudeScreenState(typed, { cursor: { x: 13, y: 3 } });

    expect(state.composerContent).toBe('commit this');
    expect(state.userDraftPresent).toBe(true);
    expect(resolveClaudeScreenInFlightSteerVeto(state)).toBe('user_draft');
  });

  it('does not treat inverse cursor position alone as placeholder evidence when the remaining text is normal', () => {
    const typedAtStart = CLAUDE_2_1_217_CURSOR_HIGHLIGHTED_SUGGESTION.replace(
      `${ESC}[0;2mommit this`,
      `${ESC}[0mommit this`,
    );
    const state = parseClaudeScreenState(typedAtStart, { cursor: { x: 2, y: 3 } });

    expect(state.composerContent).toBe('commit this');
    expect(state.userDraftPresent).toBe(true);
  });
});

// Live Lima/tmux capture 2026-06-19 (Claude Code 2.1.179-class): tmux `capture-pane -p -e`
// returned the contextual suggestion with no SGR styling, but `#{cursor_x},#{cursor_y}` showed the
// cursor at the start of the visual suggestion text. That cursor location is the host-owned proof
// that the composer input buffer is empty; without cursor evidence, plain captures still fail
// closed as drafts.
const CLAUDE_2_1_179_TMUX_PLAIN_CONTEXTUAL_SUGGESTION = [
  '  Called happier (ctrl+o to expand)',
  '',
  '● Hi! How can I help you today?',
  '',
  '✻ Brewed for 7s',
  '',
  '────────────────────────────────────────────────',
  '❯ what can you help me with',
  '────────────────────────────────────────────────',
  '  Sonnet 4.6',
  '  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents',
].join('\n');

describe('parseClaudeScreenState — plain contextual suggestion with cursor proof (tmux)', () => {
  it('treats a plain visible suggestion as an EMPTY composer when the cursor is at the text start', () => {
    const state = parseClaudeScreenState(CLAUDE_2_1_179_TMUX_PLAIN_CONTEXTUAL_SUGGESTION, {
      cursor: { x: 2, y: 7 },
    });
    expect(state.composerContent).toBe('');
    expect(state.userDraftPresent).toBe(false);
    expect(isClaudeScreenReadyForInput(state)).toBe(true);
    expect(resolveClaudeScreenInFlightSteerVeto(state)).toBeNull();
  });

  it('keeps long plain composer content as a draft even when the cursor is at the text start', () => {
    const longDraft = `❯ ${'real user draft '.repeat(12)}`;
    const state = parseClaudeScreenState(longDraft, { cursor: { x: 2, y: 0 } });

    expect(state.composerContent).toBe(longDraft.slice(2).trim());
    expect(state.userDraftPresent).toBe(true);
  });

  it('keeps the same plain text fail-closed as a draft without cursor evidence', () => {
    const state = parseClaudeScreenState(CLAUDE_2_1_179_TMUX_PLAIN_CONTEXTUAL_SUGGESTION);
    expect(state.composerContent).toBe('what can you help me with');
    expect(state.userDraftPresent).toBe(true);
  });

  it('still trusts cursor proof when unrelated border styling exists outside the composer line', () => {
    const styledChrome = CLAUDE_2_1_179_TMUX_PLAIN_CONTEXTUAL_SUGGESTION
      .replaceAll('────────────────────────────────────────────────', `${ESC}[38;2;136;136;136m────────────────────────────────────────────────${ESC}[m`);
    const state = parseClaudeScreenState(styledChrome, { cursor: { x: 2, y: 7 } });
    expect(state.composerContent).toBe('');
    expect(state.userDraftPresent).toBe(false);
  });

  it('keeps the same plain text a draft when the cursor is after the visible content', () => {
    const state = parseClaudeScreenState(CLAUDE_2_1_179_TMUX_PLAIN_CONTEXTUAL_SUGGESTION, {
      cursor: { x: 27, y: 7 },
    });
    expect(state.composerContent).toBe('what can you help me with');
    expect(state.userDraftPresent).toBe(true);
  });
});

// Live probe capture 2026-06-11 (Claude Code 2.1.173, tmux, probes/lane-n): `/effort high` on a
// conversation cached at a different effort opens a confirmation dialog instead of applying.
const CLAUDE_2_1_173 = {
  effortChangeDialog: [
    '❯ /effort low',
    '  ⎿  Set effort level to low (saved as your default for new sessions): Quick, straightforward implementation',
    '     with minimal overhead',
    '',
    '▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔',
    '   Change effort level?',
    '   Your next response will be slower and use more tokens',
    '',
    '   This conversation is cached for the current effort level. Switching to high means the full history gets',
    '   re-read on your next message.',
    '',
    '   ❯ 1. Yes, switch to high',
    '     2. No, go back',
  ].join('\n'),
  effortKept: [
    '❯ /effort low',
    '  ⎿  Set effort level to low (saved as your default for new sessions): Quick, straightforward implementation',
    '     with minimal overhead',
    '',
    '❯ /effort high',
    '  ⎿  Kept effort level as low',
    '──────────────────────────────',
    '❯ ',
    '──────────────────────────────',
  ].join('\n'),
  effortSetAfterStaleSet: [
    '❯ /effort low',
    '  ⎿  Set effort level to low (saved as your default for new sessions): Quick, straightforward implementation',
    '     with minimal overhead',
    '',
    '❯ /effort high',
    '  ⎿  Set effort level to high (saved as your default for new sessions): Comprehensive implementation with',
    '     extensive testing and documentation',
    '──────────────────────────────',
    '❯ ',
    '──────────────────────────────',
  ].join('\n'),
} as const;

describe('parseClaudeScreenState — effort change confirmation dialog (incident cmq8y3nlx, L6)', () => {
  it('detects the Change effort level? dialog with its target level and blocks the safe window', () => {
    const state = parseClaudeScreenState(CLAUDE_2_1_173.effortChangeDialog);
    expect(state.effortChangeDialogVisible).toBe(true);
    expect(state.effortChangeDialogTarget).toBe('high');
    expect(state.inputBoxInteractive).toBe(false);
    expect(isSafeWindowForSlashControl(state)).toBe(false);
    expect(isSafeWindowForModeCycle(state)).toBe(false);
    expect(isClaudeScreenReadyForInput(state)).toBe(false);
  });

  it('does not treat the dialog screen as verified via stale scrollback confirmations', () => {
    const state = parseClaudeScreenState(CLAUDE_2_1_173.effortChangeDialog);
    // The scrollback still shows "Set effort level to low"; the dialog screen must not read as a
    // clean interactive composer where that stale text could pass for verification.
    expect(state.inputBoxInteractive).toBe(false);
  });

  it('does not flag the dialog on a screen that merely echoes kept/set confirmation rows', () => {
    const state = parseClaudeScreenState(CLAUDE_2_1_173.effortKept);
    expect(state.effortChangeDialogVisible).toBe(false);
    expect(state.inputBoxInteractive).toBe(true);
    expect(isSafeWindowForSlashControl(state)).toBe(true);
  });

  it('reports the latest effort confirmation as kept when the dialog was declined', () => {
    const state = parseClaudeScreenState(CLAUDE_2_1_173.effortKept);
    expect(state.latestEffortConfirmation).toEqual({ kind: 'kept', level: 'low' });
  });

  it('prefers the LATEST set-confirmation when older ones linger in scrollback', () => {
    const state = parseClaudeScreenState(CLAUDE_2_1_173.effortSetAfterStaleSet);
    expect(state.latestEffortConfirmation).toEqual({ kind: 'set', level: 'high' });
    expect(state.visibleEffort).toBe('high');
  });

  it('does not mistake a transcript prompt echo above an empty composer for a user draft', () => {
    // Live capture 2026-06-11: executed prompts echo as `❯ reply OK again` rows in the transcript;
    // the REAL composer is the last composer line at the bottom of the screen.
    const state = parseClaudeScreenState([
      '❯ reply OK again',
      '',
      '⏺ OK. Ready when you are.',
      '──────────────────────────────',
      '❯ ',
      '──────────────────────────────',
    ].join('\n'));
    expect(state.userDraftPresent).toBe(false);
    expect(state.inputBoxInteractive).toBe(true);
    expect(isSafeWindowForSlashControl(state)).toBe(true);
  });

  it('vetoes in-flight steering while the effort dialog is visible (typed text would answer it)', () => {
    expect(resolveClaudeScreenInFlightSteerVeto(parseClaudeScreenState(CLAUDE_2_1_173.effortChangeDialog)))
      .toBe('effort_change_dialog');
  });
});

// Supplied live incident shape (Claude Code 2.1.179-class heavy-session resume interstitial):
// startup can stop on this numbered selection before the composer becomes interactive. It is a
// known blocking startup dialog, not a generic unknown confirmation.
const CLAUDE_HEAVY_SESSION_RESUME_DIALOG = [
  'This session is 18h 2m old and 560.4k tokens.',
  'To reduce startup time, Claude can resume from the saved summary or load the full session.',
  '',
  '❯ 1. Resume from summary',
  '  2. Resume full session',
].join('\n');

const CLAUDE_2_1_205_SAFEGUARD_PAUSE = readFileSync(
  new URL('./__fixtures__/claude-2.1.205-safeguard-pause.ansi', import.meta.url),
  'utf8',
);

describe('parseClaudeScreenState — heavy-session resume choice dialog', () => {
  it('recognizes the resume-choice interstitial and maps its selectable options', () => {
    const state = parseClaudeScreenState(CLAUDE_HEAVY_SESSION_RESUME_DIALOG);
    expect(state.resumeChoiceDialogVisible).toBe(true);
    expect(state.resumeChoiceDialogOptions).toEqual(['resume_from_summary', 'resume_full_session']);
    expect(state.unrecognizedConfirmationDialogVisible).toBe(false);
  });

  it('keeps the resume-choice interstitial blocking until it is answered', () => {
    const state = parseClaudeScreenState(CLAUDE_HEAVY_SESSION_RESUME_DIALOG);
    expect(state.inputBoxInteractive).toBe(false);
    expect(isClaudeScreenReadyForInput(state)).toBe(false);
    expect(isSafeWindowForSlashControl(state)).toBe(false);
    expect(isSafeWindowForModeCycle(state)).toBe(false);
    expect(resolveClaudeScreenInFlightSteerVeto(state)).toBe('resume_choice_dialog');
  });

  it('recognizes the same resume dialog when the terminal renders an ASCII focus marker', () => {
    const state = parseClaudeScreenState(CLAUDE_HEAVY_SESSION_RESUME_DIALOG.replace('❯ 1.', '> 1.'));
    expect(state.resumeChoiceDialogVisible).toBe(true);
    expect(state.resumeChoiceDialogOptions).toEqual(['resume_from_summary', 'resume_full_session']);
    expect(state.unrecognizedConfirmationDialogVisible).toBe(false);
  });

  it('keeps similar numbered dialogs fail-closed when the resume wording is not proven', () => {
    const state = parseClaudeScreenState([
      'This session is large.',
      '',
      '❯ 1. Use the fast path',
      '  2. Use all context',
    ].join('\n'));
    expect(state.resumeChoiceDialogVisible).toBe(false);
    expect(state.unrecognizedConfirmationDialogVisible).toBe(true);
  });
});

describe('parseClaudeScreenState — safeguard pause chooser (Claude Code 2.1.205)', () => {
  it('recognizes the live safeguard chooser as a first-class blocking dialog', () => {
    const state = parseClaudeScreenState(CLAUDE_2_1_205_SAFEGUARD_PAUSE);

    expect(state.safeguardPauseDialogVisible).toBe(true);
    expect(state.safeguardPauseDialogOptions).toEqual([
      { choice: 'switch_model', label: 'Switch to Opus 4.8', modelLabel: 'Opus 4.8' },
      { choice: 'edit_prompt_and_retry', label: 'Edit prompt and retry with Fable 5', modelLabel: 'Fable 5' },
    ]);
    expect(state.unrecognizedConfirmationDialogVisible).toBe(false);
    expect(isClaudeScreenReadyForInput(state)).toBe(false);
    expect(isSafeWindowForSlashControl(state)).toBe(false);
    expect(resolveClaudeScreenInFlightSteerVeto(state)).toBe('safeguard_pause_dialog');
  });

  it('keeps unrelated numbered dialogs on the generic fail-closed path', () => {
    const state = parseClaudeScreenState([
      'Claude needs a decision.',
      '',
      '❯ 1. Continue anyway',
      '  2. Stop here',
    ].join('\n'));

    expect(state.safeguardPauseDialogVisible).toBe(false);
    expect(state.unrecognizedConfirmationDialogVisible).toBe(true);
    expect(resolveClaudeScreenInFlightSteerVeto(state)).toBe('unrecognized_confirmation_dialog');
  });
});

describe('parseClaudeScreenState — visible model/effort verification text', () => {
  it('reads the model from the /model success confirmation text', () => {
    const state = parseClaudeScreenState(CLAUDE_2_1_170.modelConfirmation);
    expect(state.visibleModel).toBe('Sonnet 4.6');
  });

  it('reads the effort from /effort success confirmation text', () => {
    const state = parseClaudeScreenState('Set reasoning effort to high\n  >');
    expect(state.visibleEffort).toBe('high');
  });

  // Real Claude Code 2.1.170 confirmation text (QA probe): "Set effort level to low".
  it('reads the effort from the real "Set effort level to <x>" confirmation text', () => {
    const state = parseClaudeScreenState('Set effort level to low (saved as your default for new sessions)\n  ❯');
    expect(state.visibleEffort).toBe('low');
  });

  // Ultracode is selected through the /effort menu; the confirmation reuses the effort wording.
  // Exact live text is a probe item — the regex accepts any single lowercase word.
  it('reads ultracode from the effort confirmation text', () => {
    const state = parseClaudeScreenState('Set effort level to ultracode\n  ❯');
    expect(state.visibleEffort).toBe('ultracode');
  });

  it('reads a [1m]-suffixed model id from the /model confirmation text', () => {
    const withSuffix = parseClaudeScreenState('Set model to claude-sonnet-4-6[1m]\n  ❯');
    expect(withSuffix.visibleModel).toBe('claude-sonnet-4-6[1m]');
    // The TUI may also echo the variant without the suffix; verification stays tolerant by
    // treating any non-null echoed model as the effective value (no equality pinning).
    const saved = parseClaudeScreenState('Set model to claude-sonnet-4-6[1m] and saved as your default\n  ❯');
    expect(saved.visibleModel).toBe('claude-sonnet-4-6[1m]');
  });
});

// Real Claude Code 2.1.170 renders the composer prompt as `❯` (U+276F), not ASCII `>` or `›`.
// The synthetic G8 fixtures used `>`, masking this against the real TUI (QA probe HIGH finding).
describe('parseClaudeScreenState — real 2.1.170 composer glyph', () => {
  const realIdle = [
    '╭───────────────────────────────────────────────╮',
    '│ ❯                                               │',
    '╰───────────────────────────────────────────────╯',
    '  ? for shortcuts',
  ].join('\n');

  it('treats the real `❯` composer as an interactive input box', () => {
    const state = parseClaudeScreenState(realIdle);
    expect(state.inputBoxInteractive).toBe(true);
    expect(isSafeWindowForSlashControl(state)).toBe(true);
  });

  it('recognizes the real permissions editor heading (Permissions / Recently denied / Allow / Ask / Deny)', () => {
    const state = parseClaudeScreenState('  Permissions  Recently denied   Allow   Ask   Deny   Workspace');
    expect(state.permissionEditorOpen).toBe(true);
  });
});

describe('safe-window predicates', () => {
  it('treats an idle interactive composer as a safe window for slash controls and mode cycling', () => {
    const state = parseClaudeScreenState(CLAUDE_2_1_170.idleDefault);
    expect(isSafeWindowForSlashControl(state)).toBe(true);
    expect(isSafeWindowForModeCycle(state)).toBe(true);
  });

  it('vetoes slash controls and mode cycling during generation', () => {
    const state = parseClaudeScreenState(CLAUDE_2_1_170.generating);
    expect(isSafeWindowForSlashControl(state)).toBe(false);
    expect(isSafeWindowForModeCycle(state)).toBe(false);
  });

  it('vetoes controls while a user draft, slash picker, or dialog is visible', () => {
    expect(isSafeWindowForSlashControl(parseClaudeScreenState(CLAUDE_2_1_170.userDraft))).toBe(false);
    expect(isSafeWindowForSlashControl(parseClaudeScreenState(CLAUDE_2_1_170.slashPicker))).toBe(false);
    expect(isSafeWindowForSlashControl(parseClaudeScreenState(CLAUDE_2_1_170.permissionPrompt))).toBe(false);
    expect(isSafeWindowForModeCycle(parseClaudeScreenState(CLAUDE_2_1_170.switchModelDialog))).toBe(false);
  });

  it('vetoes controls on an unknown/non-interactive screen', () => {
    const state = parseClaudeScreenState('some heavy resume transcript with no composer');
    expect(state.inputBoxInteractive).toBe(false);
    expect(isSafeWindowForSlashControl(state)).toBe(false);
    expect(isSafeWindowForModeCycle(state)).toBe(false);
  });
});

describe('in-flight steer veto (D19)', () => {
  it('treats an actively-generating screen with a clean composer as safe to steer', () => {
    expect(resolveClaudeScreenInFlightSteerVeto(parseClaudeScreenState(CLAUDE_2_1_170.generating))).toBeNull();
    // A queued-message banner means Claude is already queueing typed input; steering more is native behavior.
    expect(resolveClaudeScreenInFlightSteerVeto(parseClaudeScreenState(CLAUDE_2_1_170.queuedMessageWhileGenerating))).toBeNull();
  });

  it('vetoes dialogs, editors, pickers, and drafts', () => {
    expect(resolveClaudeScreenInFlightSteerVeto(parseClaudeScreenState(CLAUDE_2_1_170.permissionPrompt))).toBe('permission_prompt');
    expect(resolveClaudeScreenInFlightSteerVeto(parseClaudeScreenState(CLAUDE_2_1_170.trustFolderPrompt))).toBe('trust_prompt');
    expect(resolveClaudeScreenInFlightSteerVeto(parseClaudeScreenState(CLAUDE_2_1_170.switchModelDialog))).toBe('switch_model_dialog');
    expect(resolveClaudeScreenInFlightSteerVeto(parseClaudeScreenState(CLAUDE_2_1_170.permissionsEditor))).toBe('permission_editor');
    expect(resolveClaudeScreenInFlightSteerVeto(parseClaudeScreenState(CLAUDE_2_1_170.slashPicker))).toBe('slash_picker');
    expect(resolveClaudeScreenInFlightSteerVeto(parseClaudeScreenState(CLAUDE_2_1_170.userDraft))).toBe('user_draft');
  });

  it('vetoes a mid-generation user draft in the composer', () => {
    const generatingWithDraft = [
      '● Counting to thirty…',
      '✶ Forging… (12s · esc to interrupt)',
      '╭───────────────────────────────────────────────╮',
      '│ > half-typed user thought                       │',
      '╰───────────────────────────────────────────────╯',
    ].join('\n');
    expect(resolveClaudeScreenInFlightSteerVeto(parseClaudeScreenState(generatingWithDraft))).toBe('user_draft');
  });

  // D19b: steering is "deliver unless hard-blocked", not "only while generating". An idle
  // interactive composer is SAFE — typing there submits as the next message, exactly like a user
  // typing in the attached TUI. Real-world case: an orchestrator session whose turn is running but
  // whose TUI sits idle while background agents work.
  it('treats an idle interactive composer as safe to steer (D19b)', () => {
    expect(resolveClaudeScreenInFlightSteerVeto(parseClaudeScreenState(CLAUDE_2_1_170.idleDefault))).toBeNull();
    expect(resolveClaudeScreenInFlightSteerVeto(parseClaudeScreenState(CLAUDE_2_1_170.idleAuto))).toBeNull();
  });

  it('vetoes unknown and transcript-only screens with no interactive composer (fail closed)', () => {
    expect(resolveClaudeScreenInFlightSteerVeto(parseClaudeScreenState(
      'Resuming session abc123 from on-disk history…\n(rendered 3,128 lines of prior transcript; input not yet ready)',
    ))).toBe('no_interactive_composer');
  });
});

describe('startup readiness predicate (D15 shared-parser unification)', () => {
  it('treats a boxed idle composer and mode-marked composer as ready for input', () => {
    expect(isClaudeScreenReadyForInput(parseClaudeScreenState(CLAUDE_2_1_170.idleDefault))).toBe(true);
    expect(isClaudeScreenReadyForInput(parseClaudeScreenState(CLAUDE_2_1_170.idleAcceptEdits))).toBe(true);
    expect(isClaudeScreenReadyForInput(parseClaudeScreenState(CLAUDE_2_1_170.idleAuto))).toBe(true);
  });

  it('does not declare readiness during generation, dialogs, drafts, slash pickers, or heavy resume', () => {
    expect(isClaudeScreenReadyForInput(parseClaudeScreenState(CLAUDE_2_1_170.generating))).toBe(false);
    expect(isClaudeScreenReadyForInput(parseClaudeScreenState(CLAUDE_2_1_170.switchModelDialog))).toBe(false);
    expect(isClaudeScreenReadyForInput(parseClaudeScreenState(CLAUDE_2_1_170.permissionPrompt))).toBe(false);
    expect(isClaudeScreenReadyForInput(parseClaudeScreenState(CLAUDE_2_1_170.userDraft))).toBe(false);
    expect(isClaudeScreenReadyForInput(parseClaudeScreenState(CLAUDE_2_1_170.slashPicker))).toBe(false);
    expect(isClaudeScreenReadyForInput(parseClaudeScreenState(
      'Resuming session abc123 from on-disk history…\n(rendered 3,128 lines of prior transcript; input not yet ready)',
    ))).toBe(false);
  });

  it('does not infer readiness from a mode footer while the composer is absent', () => {
    const state = parseClaudeScreenState([
      'Applied runtime control; transcript is redrawing',
      '  ⏵⏵ accept edits on (shift+tab to cycle)',
    ].join('\n'));

    expect(state.userDraftPresent).toBe(false);
    expect(state.inputBoxInteractive).toBe(true);
    expect(isClaudeScreenReadyForInput(state)).toBe(false);
    expect(isSafeWindowForSlashControl(state)).toBe(false);
    expect(isSafeWindowForModeCycle(state)).toBe(false);
    expect(resolveClaudeScreenInFlightSteerVeto(state)).toBe('no_interactive_composer');
  });
});

describe('parseClaudeScreenState — unrecognized confirmation dialogs (P-B fail-closed)', () => {
  // Shape mirrors the live 2.1.170/2.1.173 selection dialogs (`Switch model?` / `Change effort
  // level?`): a `❯`-marked numbered option list. An UNRECOGNIZED heading must fail closed —
  // typing or Escape could answer/decline it (incident cmq8y3nlx class).
  const unrecognizedDialog = [
    ' Reset conversation cache?',
    ' Your next response may be slower',
    '',
    ' ❯ 1. Yes, reset it',
    '   2. No, go back',
  ].join('\n');

  it('detects an unrecognized ❯-numbered confirmation dialog and blocks every safe window', () => {
    const state = parseClaudeScreenState(unrecognizedDialog, { cursor: { x: 3, y: 3 } });
    expect(state.unrecognizedConfirmationDialogVisible).toBe(true);
    expect(state.unrecognizedConfirmationDialog?.context).toEqual([
      'Reset conversation cache?',
      'Your next response may be slower',
    ]);
    expect(state.unrecognizedConfirmationDialog?.options).toEqual([
      { choice: '1', label: 'Yes, reset it' },
      { choice: '2', label: 'No, go back' },
    ]);
    expect(state.unrecognizedConfirmationDialog?.signature).toContain('Yes, reset it');
    expect(state.inputBoxInteractive).toBe(false);
    expect(isSafeWindowForSlashControl(state)).toBe(false);
    expect(isSafeWindowForModeCycle(state)).toBe(false);
    expect(isClaudeScreenReadyForInput(state)).toBe(false);
  });

  it('detects an ASCII-focused numbered dialog without treating it as a composer', () => {
    const state = parseClaudeScreenState([
      'WARNING: Claude Code running in Bypass Permissions mode',
      'By proceeding, you accept all responsibility for actions taken while this mode is enabled.',
      '',
      '> 1. No, exit',
      '  2. Yes, I accept',
      'Enter to confirm � Esc to cancel',
    ].join('\n'), { cursor: { x: 0, y: 3 } });

    expect(state.unrecognizedConfirmationDialogVisible).toBe(true);
    expect(state.unrecognizedConfirmationDialog?.options).toEqual([
      { choice: '1', label: 'No, exit' },
      { choice: '2', label: 'Yes, I accept' },
    ]);
    expect(state.userDraftPresent).toBe(false);
    expect(isClaudeScreenReadyForInput(state)).toBe(false);
  });

  it('captures an unindexed confirmation as a generic dialog that can self-adapt to new Claude prompts', () => {
    const state = parseClaudeScreenState([
      'Allow external CLAUDE.md file imports?',
      '',
      'This project imports instructions from outside the current working directory.',
      '',
      '❯ No, disable external imports',
      '  Yes, allow external imports',
      '',
      'Enter to confirm · Esc to cancel',
    ].join('\n'));

    expect(state.unrecognizedConfirmationDialogVisible).toBe(true);
    expect(state.unrecognizedConfirmationDialog).toMatchObject({
      context: ['Allow external CLAUDE.md file imports?', 'This project imports instructions from outside the current working directory.'],
      options: [
        { choice: 'option_1', label: 'No, disable external imports' },
        { choice: 'option_2', label: 'Yes, allow external imports' },
      ],
    });
    expect(state.userDraftPresent).toBe(false);
    expect(isClaudeScreenReadyForInput(state)).toBe(false);
  });

  it('does not let the cursor on an unindexed confirmation masquerade as the composer', () => {
    const state = parseClaudeScreenState([
      'WARNING: Claude Code running in Bypass Permissions mode',
      '',
      'By proceeding, you accept all responsibility for actions taken while running in Bypass Permissions mode.',
      '',
      '❯ No, exit',
      '  Yes, I accept',
      '',
      'Enter to confirm · Esc to cancel',
    ].join('\n'), { cursor: { x: 2, y: 4 } });

    expect(state.unrecognizedConfirmationDialogVisible).toBe(true);
    expect(state.unrecognizedConfirmationDialog?.options).toEqual([
      { choice: 'option_1', label: 'No, exit' },
      { choice: 'option_2', label: 'Yes, I accept' },
    ]);
    expect(state.composerCursorRelation).toBeNull();
    expect(isClaudeScreenReadyForInput(state)).toBe(false);
  });

  it('blocks the safe window even when a footer mode marker is visible (marker must not imply a composer)', () => {
    const state = parseClaudeScreenState([unrecognizedDialog, '', '  ⏵⏵ accept edits on'].join('\n'));
    expect(state.unrecognizedConfirmationDialogVisible).toBe(true);
    expect(state.inputBoxInteractive).toBe(false);
    expect(isSafeWindowForSlashControl(state)).toBe(false);
  });

  it('does not flag RECOGNIZED dialogs (switch model / effort change) as unrecognized', () => {
    expect(parseClaudeScreenState(CLAUDE_2_1_170.switchModelDialog).unrecognizedConfirmationDialogVisible).toBe(false);
    expect(parseClaudeScreenState(CLAUDE_2_1_173.effortChangeDialog).unrecognizedConfirmationDialogVisible).toBe(false);
    expect(parseClaudeScreenState(CLAUDE_HEAVY_SESSION_RESUME_DIALOG).unrecognizedConfirmationDialogVisible).toBe(false);
  });

  it('does not flag RECOGNIZED permission/trust prompts (owned by the permission flow, not controls)', () => {
    expect(parseClaudeScreenState(CLAUDE_2_1_170.permissionPrompt).unrecognizedConfirmationDialogVisible).toBe(false);
    expect(parseClaudeScreenState(CLAUDE_2_1_170.trustFolderPrompt).unrecognizedConfirmationDialogVisible).toBe(false);
  });

  it('does not flag an idle composer or a plain transcript echo screen', () => {
    expect(parseClaudeScreenState(CLAUDE_2_1_170.idleDefault).unrecognizedConfirmationDialogVisible).toBe(false);
    expect(parseClaudeScreenState([
      '❯ reply OK again',
      '──────────────────────────────',
      '❯ ',
      '──────────────────────────────',
    ].join('\n')).unrecognizedConfirmationDialogVisible).toBe(false);
  });

  it('lets direct cursor ownership of an empty composer override a selection-shaped transcript artifact', () => {
    const screen = [
      'Assistant response:',
      '❯ 2. Payment: cash only',
      '',
      '──────────────────────────────',
      '❯',
      '──────────────────────────────',
    ].join('\n');

    const cursorOwned = parseClaudeScreenState(screen, { cursor: { x: 2, y: 4 } });
    expect(cursorOwned.composerContent).toBe('');
    expect(cursorOwned.composerCursorRelation).toBe('at_content_start');
    expect(cursorOwned.unrecognizedConfirmationDialogVisible).toBe(false);
    expect(resolveClaudeScreenInFlightSteerVeto(cursorOwned)).toBeNull();

    const cursorElsewhere = parseClaudeScreenState(screen, { cursor: { x: 2, y: 1 } });
    expect(cursorElsewhere.composerCursorRelation).toBeNull();
    expect(cursorElsewhere.unrecognizedConfirmationDialogVisible).toBe(true);

    const cursorUnavailable = parseClaudeScreenState(screen);
    expect(cursorUnavailable.unrecognizedConfirmationDialogVisible).toBe(true);
    expect(resolveClaudeScreenInFlightSteerVeto(cursorUnavailable)).toBe('unrecognized_confirmation_dialog');
  });

  it('vetoes in-flight steering on an unrecognized confirmation dialog (typed text would answer it)', () => {
    expect(resolveClaudeScreenInFlightSteerVeto(parseClaudeScreenState(unrecognizedDialog)))
      .toBe('unrecognized_confirmation_dialog');
  });

  it.each([
    ['one option', ['Question', '❯ 1. One'].join('\n')],
    ['ten options', ['Question', ...Array.from({ length: 10 }, (_, index) => `${index === 0 ? '❯ ' : '  '}${index + 1}. Choice ${index + 1}`)].join('\n')],
    ['missing focus', ['Question', '  1. One', '  2. Two'].join('\n')],
    ['multiple focus rows', ['Question', '❯ 1. One', '❯ 2. Two'].join('\n')],
    ['non-contiguous option rows', ['Question', '❯ 1. One', 'help text', '  2. Two'].join('\n')],
    ['non-contiguous numbering', ['Question', '❯ 1. One', '  3. Three'].join('\n')],
    ['duplicate normalized labels', ['Question', '❯ 1. Retry', '  2. retry'].join('\n')],
  ])('does not expose generic answer options for %s', (_label, screen) => {
    const state = parseClaudeScreenState(screen);
    expect(state.unrecognizedConfirmationDialogVisible).toBe(_label !== 'missing focus');
    expect(state.unrecognizedConfirmationDialog).toBeNull();
  });
});

describe('composer content exposure (incident cmq7pyqkj, U1)', () => {
  it('exposes the exact composer content for command-equality checks', () => {
    const state = parseClaudeScreenState([
      '╭───────────────────────────────────────╮',
      '│ > /effort medium/effort medium        │',
      '╰───────────────────────────────────────╯',
    ].join('\n'));
    expect(state.composerContent).toBe('/effort medium/effort medium');
  });

  it('blocks in-flight steering on slash composer content even when the suggestion picker is closed', () => {
    const state = parseClaudeScreenState([
      '╭───────────────────────────────────────╮',
      '│ > /effort medium/effort medium        │',
      '╰───────────────────────────────────────╯',
    ].join('\n'));
    expect(state.slashPickerOpen).toBe(false);
    expect(resolveClaudeScreenInFlightSteerVeto(state)).toBe('slash_picker');
  });

  it('reads the BOTTOM composer line, not an executed-prompt echo above it', () => {
    const state = parseClaudeScreenState([
      '❯ /effort medium',
      '  ⎿  Set effort level to medium (saved as your default for new sessions)',
      '╭─────╮',
      '│ >   │',
      '╰─────╯',
    ].join('\n'));
    expect(state.composerContent).toBe('');
  });

  it('returns null when no composer line is present', () => {
    expect(parseClaudeScreenState('✶ Forging… (10s · esc to interrupt)').composerContent).toBeNull();
  });
});

// Live capture 2026-06-12 (Claude Code 2.1.x, zellij pane 48 cols, runner pid 20327): a long
// composer draft soft-wraps onto indented continuation lines inside the composer box. Capturing
// only the `❯` line truncated the draft, so an own-injected leftover could never exact-match the
// own-text registry (guard misclassified it foreign_draft → injection starvation, C11).
describe('parseClaudeScreenState — soft-wrapped composer draft (C11)', () => {
  const WRAPPED = [
    '⏺ BRAVO',
    '────────────────────────────────────────────────',
    '❯ QA-C11 M1: reply with exactly the word ALPHA',
    '  and nothing else',
    '────────────────────────────────────────────────',
    '  ⏵⏵ bypass permissions on (shift+tab to',
  ].join('\n');

  it('captures the FULL wrapped draft including continuation lines', () => {
    const state = parseClaudeScreenState(WRAPPED);
    expect(state.userDraftPresent).toBe(true);
    expect(state.composerContent).toBe(
      'QA-C11 M1: reply with exactly the word ALPHA\nand nothing else',
    );
  });

  it('does not bleed continuation capture past the composer bottom border', () => {
    const state = parseClaudeScreenState(WRAPPED);
    expect(state.composerContent).not.toContain('bypass permissions');
  });

  it('captures wrapped drafts inside box-bordered composers as well', () => {
    const state = parseClaudeScreenState([
      '╭──────────────────────────────╮',
      '│ ❯ first wrapped segment      │',
      '│   second wrapped segment     │',
      '╰──────────────────────────────╯',
    ].join('\n'));
    expect(state.composerContent).toBe('first wrapped segment\nsecond wrapped segment');
  });

  it('captures direct-rendered multi-paragraph drafts across blank composer rows', () => {
    const state = parseClaudeScreenState([
      '────────────────────────────────────────────────',
      '❯ great, awesome! great work',
      '',
      '  but seems like a lot of texts are still not translated?',
      '  http://localhost:5173/zh-Hant',
      '────────────────────────────────────────────────',
      '  ⏵⏵ auto mode on (shift+tab to cycle)',
    ].join('\n'));

    expect(state.composerContent).toBe([
      'great, awesome! great work',
      '',
      'but seems like a lot of texts are still not translated?',
      'http://localhost:5173/zh-Hant',
    ].join('\n'));
  });

  it('keeps blank paragraph rows inside a box-bordered composer', () => {
    const state = parseClaudeScreenState([
      '╭──────────────────────────────╮',
      '│ ❯ first paragraph            │',
      '│                              │',
      '│   second paragraph           │',
      '╰──────────────────────────────╯',
    ].join('\n'));

    expect(state.composerContent).toBe('first paragraph\n\nsecond paragraph');
  });

  it('keeps single-line drafts and empty composers unchanged', () => {
    const single = parseClaudeScreenState([
      '──────────────',
      '❯ short draft',
      '──────────────',
    ].join('\n'));
    expect(single.composerContent).toBe('short draft');
    const empty = parseClaudeScreenState([
      '──────────────',
      '❯ ',
      '──────────────',
      '  ⏵⏵ bypass permissions on',
    ].join('\n'));
    expect(empty.composerContent).toBe('');
  });
});

// Live capture 2026-06-12 11:50 (orchestrator runner pid 58731, zellij dump): the AGENTS panel
// ("← for agents", `↑/↓ to select · Enter to view`) renders its selection cursor as
// `❯ ◯ <agent-type> <title>` rows. The cursor row parsed as a composer draft → false `user_draft`
// steer veto with a misleading "clear the draft in the terminal" notice (draftLength flapped 29/41
// as the list redrew). Typing/Enter on this screen drives the SELECTOR, never the composer.
describe('parseClaudeScreenState — agents selection panel (live 11:36 incident)', () => {
  const AGENTS_PANEL = [
    '─────────────────────────────────────────────',
    '  ⏵⏵ bypass permissions on · 9 shells · ← for agents',
    '  ⏺ main                                  ↑/↓ to select · Enter to view',
    '❯ ◯ general-purpose  QA-A lane resume          51m 0s · ↓ 154.0k tokens',
    '  ◯ general-purpose  QA-B lane resume         50m 53s · ↓ 192.8k tokens',
    '  ◯ general-purpose  Stale-intent follow-up fix lane   7m 36s · ↓ 151.6k tokens',
  ].join('\n');

  it('never reads the selection cursor row as a composer draft', () => {
    const state = parseClaudeScreenState(AGENTS_PANEL);
    expect(state.userDraftPresent).toBe(false);
    expect(state.composerContent).toBeNull();
  });

  it('reports the selection list and blocks steering with a non-draft reason', () => {
    const state = parseClaudeScreenState(AGENTS_PANEL);
    expect(state.selectionListVisible).toBe(true);
    expect(resolveClaudeScreenInFlightSteerVeto(state)).toBe('selection_list');
  });

  it('recognizes an ASCII-focused selector row as the same terminal-owned selection list', () => {
    const state = parseClaudeScreenState(AGENTS_PANEL
      .replace('❯ ◯', '> ◯')
      .split('\n')
      .filter((line) => !line.includes('↑/↓ to select'))
      .join('\n'));
    expect(state.selectionListVisible).toBe(true);
    expect(state.composerContent).toBeNull();
    expect(resolveClaudeScreenInFlightSteerVeto(state)).toBe('selection_list');
  });

  it('keeps controls/typing blocked while the selector is on screen', () => {
    const state = parseClaudeScreenState(AGENTS_PANEL);
    expect(isSafeWindowForSlashControl(state)).toBe(false);
    expect(isClaudeScreenReadyForInput(state)).toBe(false);
  });

  // Live capture 2026-06-12 14:0x (incident cmq9x64qc, runner pid 17342, zellij dump-screen):
  // while background agents run, Claude renders a PASSIVE tasks footer BELOW the interactive
  // composer — `⏺ main … ↑/↓ to select · Enter to view` plus non-focused `◯ <agent>` rows (no `❯`
  // cursor row). Typing on this screen drives the COMPOSER, not the footer, but the bare
  // `↑/↓ to select` hint matched as a selection list and steer-vetoed `selection_list` for the
  // entire background-agent wait (user message never delivered). The hint alone, with an
  // interactive composer on screen, must NOT block; a focused `❯ ◯` cursor row still must.
  const BACKGROUND_AGENTS_FOOTER_WITH_COMPOSER = [
    '✻ Waiting for 3 background agents to finish',
    '',
    '─────────────────────────────────────────────',
    '❯ ',
    '─────────────────────────────────────────────',
    '  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents',
    '',
    '  ⏺ main                                  ↑/↓ to select · Enter to view',
    '  ◯ general-purpose  Analyze Pi SDK vs our plugin SDK      2m 8s · ↓ 121.5k tokens',
    '  ◯ general-purpose  W6 fix lane: apply review resolutions  1m 5s · ↓ 68.4k tokens',
  ].join('\n');

  it('does not block steering on the passive background-agents footer when the composer is interactive (incident cmq9x64qc)', () => {
    const state = parseClaudeScreenState(BACKGROUND_AGENTS_FOOTER_WITH_COMPOSER);
    expect(state.selectionListVisible).toBe(false);
    expect(state.composerContent).toBe('');
    expect(state.userDraftPresent).toBe(false);
    expect(resolveClaudeScreenInFlightSteerVeto(state)).toBeNull();
  });

  it('still blocks on the footer hint when NO interactive composer is on screen (fail closed)', () => {
    const state = parseClaudeScreenState([
      '  ⏺ main                                  ↑/↓ to select · Enter to view',
      '  ◯ general-purpose  QA lane resume          51m 0s · ↓ 154.0k tokens',
    ].join('\n'));
    expect(state.selectionListVisible).toBe(true);
    expect(resolveClaudeScreenInFlightSteerVeto(state)).toBe('selection_list');
  });

  it('still blocks when the selector cursor row is focused even with a composer visible', () => {
    const state = parseClaudeScreenState([
      '❯ ',
      '  ⏺ main                                  ↑/↓ to select · Enter to view',
      '❯ ◯ general-purpose  QA lane resume          51m 0s · ↓ 154.0k tokens',
    ].join('\n'));
    expect(state.selectionListVisible).toBe(true);
    expect(resolveClaudeScreenInFlightSteerVeto(state)).toBe('selection_list');
  });

  it('does not flag a normal composer screen as a selection list', () => {
    const state = parseClaudeScreenState([
      '──────────────',
      '❯ a real draft',
      '──────────────',
      '  ⏵⏵ bypass permissions on',
    ].join('\n'));
    expect(state.selectionListVisible).toBe(false);
    expect(state.userDraftPresent).toBe(true);
  });
});
