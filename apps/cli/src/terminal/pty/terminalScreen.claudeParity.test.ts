import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { buildTerminalControlCapture } from '@/integrations/terminalHost/controlCapture';
import {
  isClaudeScreenReadyForInput,
  isSafeWindowForModeCycle,
  isSafeWindowForSlashControl,
  parseClaudeScreenState,
  resolveClaudeScreenInFlightSteerVeto,
} from '../../../../../packages/plugins/claude/src/agent/runtime/terminal/unified/screenState';
import { classifyClaudeOwnComposerDraft } from '../../../../../packages/plugins/claude/src/agent/runtime/terminal/unified/ownComposerDraftClassification';
import { isClaudeUnifiedComposerTextMatch } from '../../../../../packages/plugins/claude/src/agent/runtime/terminal/unified/promptIdentity';
import { createClaudePromptSubmitVerificationPolicy } from '../../../../../packages/plugins/claude/src/agent/runtime/terminal/unified/promptSubmitVerification';
import { hasComposerLineStyleEvidence } from '../../../../../packages/plugins/claude/src/agent/runtime/terminal/unified/composerStyleEvidence';
import { createTerminalScreen, loadTerminalScreenModel, type TerminalScreenCapture } from './terminalScreen';

/**
 * Screen-model parity (HOLDER-PTY U1, P03-XTERM-PARITY): real Claude Code 2.1.325 PTY byte
 * streams (mock API, synthetic prompts) replayed through the PTY host's screen model. At every
 * mark, the Claude unified classifier decisions must equal those from `tmux capture-pane -p -e`
 * of the same bytes (recorded in each fixture's `expected`). The streams include Claude's
 * mid-session `ESC ( B`, full-width prompts, a permission dialog, the slash picker, resizes
 * and an interrupt.
 */
type FixtureEvent =
  | Readonly<{ k: 'o'; b: string }>
  | Readonly<{ k: 'r'; cols: number; rows: number }>
  | Readonly<{ k: 'm'; name: string; prompt?: string }>;

type Fixture = Readonly<{ cols: number; rows: number; events: readonly FixtureEvent[]; expected: Readonly<Record<string, Record<string, unknown>>> }>;

const fixturesDirectory = fileURLToPath(new URL('./__fixtures__/claude-tui/', import.meta.url));
const scenarios = readdirSync(fixturesDirectory).filter(name => name.endsWith('.json')).map(name => name.slice(0, -'.json'.length));

/** The decisions the Claude unified runtime takes from one capture, as the PTY host hands it over. */
function decide(capture: TerminalScreenCapture, prompt: string | undefined): Record<string, unknown> {
  const control = buildTerminalControlCapture({ rawText: capture.styledText ?? capture.text, cursor: capture.cursor,
    hostKind: 'pty', capturedAtMs: 0 });
  const parserInput = control.styledText ?? control.text;
  const state = parseClaudeScreenState(parserInput, { cursor: control.cursor });
  const own = prompt ?? '';
  const policy = createClaudePromptSubmitVerificationPolicy();
  let beforeSubmit = 'n/a';
  let afterSubmit = 'n/a';
  if (prompt) {
    // The host verifies submission against the plain capture text.
    try { beforeSubmit = String(policy.verifyBeforeSubmitStaging!({ promptText: prompt, screenText: control.text })); }
    catch (error) { beforeSubmit = `threw:${(error as Error).message}`; }
    afterSubmit = String(policy.verifyAfterSubmit({ promptText: prompt, screenText: control.text }));
  }
  return {
    ready: isClaudeScreenReadyForInput(state),
    inputBoxInteractive: state.inputBoxInteractive,
    generating: state.generating,
    permissionPromptVisible: state.permissionPromptVisible,
    slashPickerOpen: state.slashPickerOpen,
    selectionListVisible: state.selectionListVisible,
    unrecognizedDialog: state.unrecognizedConfirmationDialogVisible,
    queuedBanner: state.queuedMessageBannerVisible,
    userDraftPresent: state.userDraftPresent,
    composerContent: state.composerContent,
    cursorRelation: state.composerCursorRelation,
    modeMarker: state.modeMarker,
    slashSafe: isSafeWindowForSlashControl(state),
    modeCycleSafe: isSafeWindowForModeCycle(state),
    steerVeto: resolveClaudeScreenInFlightSteerVeto(state),
    ownDraft: classifyClaudeOwnComposerDraft({ screen: state, rawText: parserInput,
      ownComposerTexts: { matches: draft => own.length > 0
        && isClaudeUnifiedComposerTextMatch({ promptText: own, composerText: draft, allowShortVisibleWindow: true }) } }),
    styleEvidence: state.composerContent ? hasComposerLineStyleEvidence(parserInput, state.composerContent) : null,
    beforeSubmit,
    afterSubmit,
  };
}

describe('PTY host screen model: Claude unified decisions equal tmux on recorded Claude streams', () => {
  it.each(scenarios)('%s', async (scenario) => {
    const fixture = JSON.parse(readFileSync(join(fixturesDirectory, `${scenario}.json`), 'utf8')) as Fixture;
    const screen = createTerminalScreen(await loadTerminalScreenModel(), { cols: fixture.cols, rows: fixture.rows });
    const decided: Record<string, Record<string, unknown>> = {};
    for (const event of fixture.events) {
      if (event.k === 'o') screen.write(Buffer.from(event.b, 'base64'));
      else if (event.k === 'r') screen.resize(event.cols, event.rows);
      // A capture waits for every byte written before it to be parsed.
      else decided[event.name] = decide(await screen.capture(), event.prompt);
    }
    screen.dispose();
    expect(Object.keys(decided).length).toBeGreaterThan(0);
    expect(decided).toEqual(fixture.expected);
  });

  it('never prints the G0 charset designation that Claude re-asserts mid-session (ESC ( B)', async () => {
    const screen = createTerminalScreen(await loadTerminalScreenModel(), { cols: 20, rows: 3 });
    screen.write('\u001b[1;1H❯ \u001b(B\u000f\u001b[?2004h');
    expect((await screen.capture()).text).toBe('❯');
    screen.dispose();
  });

  it('carries SGR dim in the styled capture (the empty-composer placeholder)', async () => {
    const screen = createTerminalScreen(await loadTerminalScreenModel(), { cols: 30, rows: 3 });
    screen.write('❯ \u001b[2mTry "fix lint"\u001b[0m');
    const capture = await screen.capture();
    expect(capture.text).toBe('❯ Try "fix lint"');
    expect(capture.styledText).toBe('❯ \u001b[0;2mTry "fix lint"\u001b[0m');
    screen.dispose();
  });
});
