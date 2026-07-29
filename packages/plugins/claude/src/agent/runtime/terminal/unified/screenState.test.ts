import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  isClaudeScreenReadyForInput,
  isSafeWindowForModeCycle,
  isSafeWindowForSlashControl,
  parseClaudeScreenState,
  resolveClaudeScreenInFlightSteerVeto,
} from './screenState.js';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__');

function ready(screen: string): boolean {
  return isClaudeScreenReadyForInput(parseClaudeScreenState(screen));
}

describe('parseClaudeScreenState readiness', () => {
  it('recognizes the provenance-pinned Claude 2.1.205 Fable safeguard chooser', () => {
    const capture = readFileSync(join(fixturesDir, 'claude-2.1.205-safeguard-pause.ansi'), 'utf8');
    const state = parseClaudeScreenState(capture);

    expect(state.safeguardPauseDialogVisible).toBe(true);
    expect(state.safeguardPauseDialogOptions).toEqual([
      { choice: 'switch_model', label: 'Switch to Opus 4.8', modelLabel: 'Opus 4.8' },
      { choice: 'edit_prompt_and_retry', label: 'Edit prompt and retry with Fable 5', modelLabel: 'Fable 5' },
    ]);
  });
  it('recognizes the boxed composer the real TUI renders', () => {
    const screen = [
      '╭──────────────────────────────╮',
      '│ >                            │',
      '╰──────────────────────────────╯',
    ].join('\n');
    expect(ready(screen)).toBe(true);
  });

  it('recognizes the ❯ composer glyph (U+276F)', () => {
    expect(ready('❯ ')).toBe(true);
  });

  it('does not treat a ❯-marked dialog menu selection line as a composer', () => {
    const screen = [
      'Switch model?',
      '❯ 1. Yes',
      '  2. No',
    ].join('\n');
    expect(ready(screen)).toBe(false);
  });

  it('exposes the composer draft content for own-leftover matching (lane X1)', () => {
    const state = parseClaudeScreenState('│ > my pending draft │');
    expect(state.userDraftPresent).toBe(true);
    expect(state.composerContent).toBe('my pending draft');

    const empty = parseClaudeScreenState('│ > │');
    expect(empty.composerContent).toBe('');
    expect(parseClaudeScreenState('no composer here').composerContent).toBeNull();
  });

  it('recognizes the fresh-session work prompt', () => {
    expect(ready('What would you like to work on?')).toBe(true);
  });

  it('recognizes a mode-marked composer screen', () => {
    expect(ready('accept edits on (shift+tab to cycle)')).toBe(true);
  });

  it('stays not-ready while generating', () => {
    expect(ready('✻ Pondering… (esc to interrupt)\n│ > │')).toBe(false);
  });

  it('stays not-ready while the permissions editor tab row is visible', () => {
    const screen = 'Permissions  Recently denied  Allow  Ask  Deny  Workspace\n│ > │';
    expect(ready(screen)).toBe(false);
  });

  it('stays not-ready for trust-folder and permission dialogs', () => {
    expect(ready('Do you trust the files in this folder?\n❯ 1. Yes, proceed')).toBe(false);
    expect(ready('Bash command…\nDo you want to proceed?\n❯ 1. Yes')).toBe(false);
  });

  it('stays not-ready while the slash command picker is open', () => {
    const screen = [
      '│ > /mod │',
      '  /model Switch the current model',
    ].join('\n');
    expect(ready(screen)).toBe(false);
  });

  it('stays not-ready while the user holds a draft in the composer', () => {
    expect(ready('│ > draft text the user typed │')).toBe(false);
  });

  it('stays not-ready on heavy-resume non-interactive screens', () => {
    const screen = [
      'Loading conversation...',
      'Rendering resumed transcript history',
      'Running 6 Explore agents...',
    ].join('\n');
    expect(ready(screen)).toBe(false);
  });

  it('recognizes Claude heavy-session resume choice as a known blocking dialog', () => {
    const screen = [
      'This session is 18h 2m old and 560.4k tokens.',
      '',
      '❯ 1. Resume from summary',
      '  2. Resume full session',
    ].join('\n');
    const state = parseClaudeScreenState(screen);

    expect(state.resumeChoiceDialogVisible).toBe(true);
    expect(state.resumeChoiceDialogOptions).toEqual(['resume_from_summary', 'resume_full_session']);
    expect(state.unrecognizedConfirmationDialogVisible).toBe(false);
    expect(isClaudeScreenReadyForInput(state)).toBe(false);
    expect(isSafeWindowForSlashControl(state)).toBe(false);
    expect(isSafeWindowForModeCycle(state)).toBe(false);
    expect(resolveClaudeScreenInFlightSteerVeto(state)).toBe('resume_choice_dialog');
  });

  it('recognizes the Fable safeguard pause chooser as a known blocking dialog', () => {
    const screen = [
      'Session paused',
      '',
      "Fable 5's safeguards flagged this message.",
      '',
      '❯ 1. Switch to Opus 4.8',
      '  2. Edit prompt and retry with Fable 5',
    ].join('\n');
    const state = parseClaudeScreenState(screen);

    expect(state.safeguardPauseDialogVisible).toBe(true);
    expect(state.safeguardPauseDialogOptions).toEqual([
      { choice: 'switch_model', label: 'Switch to Opus 4.8', modelLabel: 'Opus 4.8' },
      { choice: 'edit_prompt_and_retry', label: 'Edit prompt and retry with Fable 5', modelLabel: 'Fable 5' },
    ]);
    expect(state.unrecognizedConfirmationDialogVisible).toBe(false);
    expect(isClaudeScreenReadyForInput(state)).toBe(false);
    expect(isSafeWindowForSlashControl(state)).toBe(false);
    expect(isSafeWindowForModeCycle(state)).toBe(false);
    expect(resolveClaudeScreenInFlightSteerVeto(state)).toBe('safeguard_pause_dialog');
  });

  it('recognizes the captured Claude usage-limit dialog as provider unavailable, not a composer draft', () => {
    const incident = readFileSync(join(fixturesDir, 'incident-89861-ratelimit-resume.ansi'), 'utf8');
    const state = parseClaudeScreenState(incident);

    expect(state).toMatchObject({
      composerContent: '/rate-limit-options',
      userDraftPresent: false,
      usageLimitDialogVisible: true,
      unrecognizedConfirmationDialogVisible: false,
      inputBoxInteractive: false,
    });
    expect(isClaudeScreenReadyForInput(state)).toBe(false);
    expect(resolveClaudeScreenInFlightSteerVeto(state)).toBe('usage_limit_dialog');
  });

  it('keeps a captured healthy idle composer writable', () => {
    const healthy = readFileSync(join(fixturesDir, 'healthy-92862-idle.ansi'), 'utf8');
    const state = parseClaudeScreenState(healthy);

    expect(state).toMatchObject({
      composerContent: '',
      userDraftPresent: false,
      inputBoxInteractive: true,
    });
    expect(isClaudeScreenReadyForInput(state)).toBe(true);
    expect(resolveClaudeScreenInFlightSteerVeto(state)).toBeNull();
  });

  it('treats Claude resume prefill text as an empty non-draft composer', () => {
    const state = parseClaudeScreenState('❯ Continue where you left off');

    expect(state.composerContent).toBe('');
    expect(state.userDraftPresent).toBe(false);
    expect(isClaudeScreenReadyForInput(state)).toBe(true);
  });

  it('keeps similar unknown numbered startup dialogs fail-closed', () => {
    const screen = [
      'This session is 18h 2m old and 560.4k tokens.',
      '',
      '❯ 1. Delete history',
      '  2. Continue anyway',
    ].join('\n');
    const state = parseClaudeScreenState(screen);

    expect(state.resumeChoiceDialogVisible).toBe(false);
    expect(state.resumeChoiceDialogOptions).toEqual([]);
    expect(state.unrecognizedConfirmationDialogVisible).toBe(true);
    expect(resolveClaudeScreenInFlightSteerVeto(state)).toBe('unrecognized_confirmation_dialog');
  });
});

describe('parseClaudeScreenState control echoes', () => {
  it('parses a [1m] model confirmation echo, with and without "and saved"', () => {
    expect(parseClaudeScreenState('Set model to claude-sonnet-4-6[1m]').visibleModel)
      .toBe('claude-sonnet-4-6[1m]');
    expect(parseClaudeScreenState('Set model to claude-sonnet-4-6[1m] and saved').visibleModel)
      .toBe('claude-sonnet-4-6[1m]');
  });

  it('parses the real 2.1.170 effort confirmation wording including ultracode', () => {
    expect(parseClaudeScreenState('Set effort level to xhigh').visibleEffort).toBe('xhigh');
    expect(parseClaudeScreenState('Set effort level to ultracode').visibleEffort).toBe('ultracode');
  });
});

describe('resolveClaudeScreenInFlightSteerVeto', () => {
  // Live capture 2026-06-11 (remote-dev incident cmq8y3nlx): the real spinner can omit
  // "esc to interrupt" (`\u273d Billowing\u2026 (10m 24s \u00b7 \u2193 20.4k tokens)`).
  it('detects generation from a real spinner line WITHOUT the esc-to-interrupt suffix', () => {
    const liveCapture = [
      '\u273d Billowing\u2026 (10m 24s \u00b7 \u2193 20.4k tokens)',
      '\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500',
      '\u276f ',
      '\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500',
    ].join('\n');
    expect(parseClaudeScreenState(liveCapture).generating).toBe(true);
  });

  it('does not mistake a completion line (no parens) for generation', () => {
    expect(parseClaudeScreenState('\u2733 Crunched for 6s\n\u276f ').generating).toBe(false);
  });

  // D19b: an idle interactive composer is a SAFE steer surface — typed text submits as the next
  // message, exactly like typing in the attached TUI.
  it('is safe on an idle interactive composer (D19b)', () => {
    const idle = '\u256d\u2500\u2500\u2500\u256e\n\u2502 > \u2502\n\u2570\u2500\u2500\u2500\u256f\n  ? for shortcuts';
    expect(resolveClaudeScreenInFlightSteerVeto(parseClaudeScreenState(idle))).toBeNull();
  });

  it('is safe while provably generating with a clean composer', () => {
    const state = parseClaudeScreenState('✻ Pondering… (esc to interrupt)\n│ > │');
    expect(resolveClaudeScreenInFlightSteerVeto(state)).toBeNull();
  });

  it('treats the queued-message banner as proof Claude is queueing typed input', () => {
    const state = parseClaudeScreenState('Press up to edit queued messages\n│ > │');
    expect(resolveClaudeScreenInFlightSteerVeto(state)).toBeNull();
  });

  it.each([
    ['permission_prompt', 'Do you want to proceed?\n❯ 1. Yes'],
    ['trust_prompt', 'Do you trust the files in this folder?'],
    ['switch_model_dialog', 'Switch model?\n❯ 1. Yes'],
    ['permission_editor', 'Permissions  Recently denied  Allow  Ask  Deny  Workspace'],
    ['user_draft', '✻ Pondering… (esc to interrupt)\n│ > user draft │'],
    ['no_interactive_composer', 'transcript only, no composer at all'],
  ])('vetoes %s screens (fail-closed)', (reason, screen) => {
    expect(resolveClaudeScreenInFlightSteerVeto(parseClaudeScreenState(screen))).toBe(reason);
  });

  it('vetoes the slash picker mid-generation', () => {
    const screen = [
      '✻ Pondering… (esc to interrupt)',
      '│ > /mod │',
      '  /model Switch the current model',
    ].join('\n');
    expect(resolveClaudeScreenInFlightSteerVeto(parseClaudeScreenState(screen))).toBe('slash_picker');
  });
});

// Live probe capture 2026-06-11 (Claude Code 2.1.173, tmux): `/effort high` on a conversation
// cached at a different effort opens a confirmation dialog instead of applying.
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

  it('does not flag the dialog on a screen that merely echoes kept/set confirmation rows', () => {
    const state = parseClaudeScreenState(CLAUDE_2_1_173.effortKept);
    expect(state.effortChangeDialogVisible).toBe(false);
    expect(state.inputBoxInteractive).toBe(true);
    expect(isSafeWindowForSlashControl(state)).toBe(true);
  });

  it('reports the latest effort confirmation as kept when the dialog was declined', () => {
    const state = parseClaudeScreenState(CLAUDE_2_1_173.effortKept);
    expect(state.latestEffortConfirmation).toEqual({ kind: 'kept', level: 'low' });
    expect(state.keptEffortNoticeCount).toBe(1);
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
    expect(parseClaudeScreenState(typed).userDraftPresent).toBe(true);
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
    expect(state.inputBoxInteractive).toBe(false);
    expect(isSafeWindowForSlashControl(state)).toBe(false);
    expect(isSafeWindowForModeCycle(state)).toBe(false);
    expect(isClaudeScreenReadyForInput(state)).toBe(false);
  });

  it('blocks the safe window even when a footer mode marker is visible (marker must not imply a composer)', () => {
    const state = parseClaudeScreenState([unrecognizedDialog, '', '  ⏵⏵ accept edits on'].join('\n'));
    expect(state.unrecognizedConfirmationDialogVisible).toBe(true);
    expect(state.inputBoxInteractive).toBe(false);
    expect(isSafeWindowForSlashControl(state)).toBe(false);
  });

  it('does not flag RECOGNIZED dialogs (switch model / effort change / permission / trust)', () => {
    expect(parseClaudeScreenState('Switch model?\n❯ 1. Yes, switch\n  2. No, go back').unrecognizedConfirmationDialogVisible).toBe(false);
    expect(parseClaudeScreenState(CLAUDE_2_1_173.effortChangeDialog).unrecognizedConfirmationDialogVisible).toBe(false);
    expect(parseClaudeScreenState('Do you want to proceed?\n❯ 1. Yes').unrecognizedConfirmationDialogVisible).toBe(false);
    expect(parseClaudeScreenState('Do you trust the files in this folder?\n❯ 1. Yes, proceed').unrecognizedConfirmationDialogVisible).toBe(false);
  });

  it('does not flag an idle composer or a plain transcript echo screen', () => {
    expect(parseClaudeScreenState('│ > │').unrecognizedConfirmationDialogVisible).toBe(false);
    expect(parseClaudeScreenState([
      '❯ reply OK again',
      '──────────────────────────────',
      '❯ ',
      '──────────────────────────────',
    ].join('\n')).unrecognizedConfirmationDialogVisible).toBe(false);
  });

  it('does not let stale incomplete selection-shaped output override a cursor-proven idle DIM suggestion', () => {
    // Semantic port of Remote runner pid 57509 evidence. Dev keeps its plugin-native screen owner:
    // a prior incomplete selection-shaped row cannot turn the exact active composer into a dialog.
    const screen = [
      '❯ 1. completed transcript output, not a chooser',
      '',
      '\x1b[38;2;255;255;255m⏺\x1b[39m QA_SWIFT_DIALOG_TRIGGER_DONE',
      '',
      '\x1b[38;2;153;153;153m✻\x1b[39m \x1b[38;2;153;153;153mChurned for 24s\x1b[39m',
      '',
      '\x1b[38;2;136;136;136m────────────────────────────────────────────────',
      '\x1b[39m❯ \x1b[2mrun it\x1b[0m',
      '\x1b[38;2;136;136;136m────────────────────────────────────────────────',
      '\x1b[39m',
      '  \x1b[38;2;255;193;7m⏵⏵ auto mode on\x1b[38;2;153;153;153m (shift+tab to cycle) · ← for agents\x1b[39m',
    ].join('\n');
    const state = parseClaudeScreenState(screen, { cursor: { x: 2, y: 7 } });

    expect(state.composerContent).toBe('');
    expect(state.userDraftPresent).toBe(false);
    expect(state.unrecognizedConfirmationDialog).toBeNull();
    expect(state.unrecognizedConfirmationDialogVisible).toBe(false);
    expect(isClaudeScreenReadyForInput(state)).toBe(true);
    expect(resolveClaudeScreenInFlightSteerVeto(state)).toBeNull();
  });

  it('vetoes in-flight steering on an unrecognized confirmation dialog (typed text would answer it)', () => {
    expect(resolveClaudeScreenInFlightSteerVeto(parseClaudeScreenState(unrecognizedDialog)))
      .toBe('unrecognized_confirmation_dialog');
  });
});

describe('safe-window predicates', () => {
  it('treats an idle interactive composer as a safe window for slash controls and mode cycling', () => {
    const state = parseClaudeScreenState('│ > │\n  ? for shortcuts');
    expect(isSafeWindowForSlashControl(state)).toBe(true);
    expect(isSafeWindowForModeCycle(state)).toBe(true);
  });

  it('vetoes slash controls and mode cycling during generation', () => {
    const state = parseClaudeScreenState('✻ Pondering… (esc to interrupt)\n│ > │');
    expect(isSafeWindowForSlashControl(state)).toBe(false);
    expect(isSafeWindowForModeCycle(state)).toBe(false);
  });

  it('vetoes controls while a user draft or slash picker is visible', () => {
    expect(isSafeWindowForSlashControl(parseClaudeScreenState('│ > user draft │'))).toBe(false);
    expect(isSafeWindowForSlashControl(parseClaudeScreenState('│ > /mod │\n  /model Switch the current model'))).toBe(false);
  });

  it('vetoes controls on an unknown/non-interactive screen', () => {
    expect(isSafeWindowForSlashControl(parseClaudeScreenState('transcript only, no composer'))).toBe(false);
    expect(isSafeWindowForModeCycle(parseClaudeScreenState('transcript only, no composer'))).toBe(false);
  });
});

// Live capture 2026-06-12 11:50 (remote-dev incident, zellij dump): the AGENTS panel
// ("← for agents", `↑/↓ to select · Enter to view`) renders its selection cursor as
// `❯ ◯ <agent-type> <title>` rows. The cursor row parsed as a composer draft → false `user_draft`
// steer veto with a misleading "clear the draft in the terminal" notice. Typing/Enter on this
// screen drives the SELECTOR, never the composer.
describe('parseClaudeScreenState — agents selection panel (ported S-4+S-5, refined semantic)', () => {
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

  it('keeps controls/typing blocked while the selector is on screen', () => {
    const state = parseClaudeScreenState(AGENTS_PANEL);
    expect(isSafeWindowForSlashControl(state)).toBe(false);
    expect(isClaudeScreenReadyForInput(state)).toBe(false);
  });

  // Live capture 2026-06-12 14:0x (remote-dev incident cmq9x64qc): while background agents run,
  // Claude renders a PASSIVE tasks footer BELOW the interactive composer — `⏺ main … ↑/↓ to
  // select · Enter to view` plus non-focused `◯ <agent>` rows (no `❯` cursor row). Typing on
  // that screen drives the COMPOSER, not the footer; the bare hint under a live composer must
  // NOT veto steering (the unrefined hint-only matcher starved steering for the entire
  // background-agent wait). A focused `❯ ◯` cursor row still must.
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

  it('does not block steering on the passive background-agents footer when the composer is interactive', () => {
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

// Live capture 2026-06-12 (remote-dev C11, zellij pane 48 cols): a long composer draft
// soft-wraps onto indented continuation lines inside the composer box. Capturing only the `❯`
// line truncated the draft, so an own-injected leftover could never exact-match the own-text
// registry (guard misclassified it as a foreign draft → injection starvation).
describe('parseClaudeScreenState — soft-wrapped composer draft (ported S-2)', () => {
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

// Live capture 2026-06-12 (remote-dev QA-B F6, Claude Code 2.1.174, zellij `dump-screen --ansi`):
// a CONTEXTUAL suggestion (`❯ check the output`) with arbitrary text — no `Try "<hint>"`
// quoting — so the only honest discriminator is the DIM (SGR 2) styling Claude Code uses for
// placeholder text. Parsing it as a user draft blocked every pending injection forever.
const ESC = String.fromCharCode(0x1b);
const CLAUDE_2_1_174_DIM_SUGGESTION_ANSI = [
  `${ESC}[m⏺ Background command "Run sleep and echo command`,
  'in background" completed (exit code 0)',
  '',
  '⏺ B2-ok',
  '',
  `${ESC}[38;2;136;136;136m────────────────────────────────────────────────${ESC}[m`,
  // Exact live byte shape: reset, glyph, SGR resets, then DIM (2) before the hint text.
  `${ESC}[m❯ ${ESC}[39m${ESC}[49m${ESC}[29m${ESC}[28m${ESC}[27m${ESC}[25m${ESC}[25m${ESC}[22m${ESC}[24m${ESC}[2m${ESC}[23mcheck the output`,
  `${ESC}[38;2;136;136;136m────────────────────────────────────────────────${ESC}[m`,
  '',
  '  ⏵⏵ accept edits on (shift+tab to cycle)',
].join('\n');

describe('parseClaudeScreenState — dim contextual suggestion placeholder (ported S-8)', () => {
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

// Remote-first live tmux evidence from Claude Code 2.1.217. Dev keeps the provider-native screen
// parser as its owner and ports the semantic discriminator, not Remote's host/runtime topology.
const CLAUDE_2_1_217_CURSOR_HIGHLIGHTED_SUGGESTION = readFileSync(
  join(fixturesDir, 'incident-98095-contextual-suggestion.ansi'),
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
