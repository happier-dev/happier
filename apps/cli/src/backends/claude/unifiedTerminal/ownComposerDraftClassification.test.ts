import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { classifyClaudeOwnComposerDraft } from './ownComposerDraftClassification';
import { parseClaudeScreenState } from './tuiControls/screenState';

function readFixture(name: string): string {
  return readFileSync(resolve(__dirname, 'tuiControls/__fixtures__', name), 'utf8');
}

function classifyScreen(rawText: string): ReturnType<typeof classifyClaudeOwnComposerDraft> {
  const screen = parseClaudeScreenState(rawText);
  return classifyClaudeOwnComposerDraft({
    screen,
    rawText,
    ownComposerTexts: { matches: () => false },
    stopOnGenerating: false,
  });
}

function boxedComposer(content: string): string {
  return [
    '────────────────────────────────────────────────',
    `❯ ${content}`,
    '────────────────────────────────────────────────',
    '',
    '  ⏵⏵ accept edits on (shift+tab to cycle)',
  ].join('\n');
}

describe('classifyClaudeOwnComposerDraft', () => {
  it('classifies the captured healthy idle screen as empty', () => {
    const rawText = readFixture('healthy-92862-idle.ansi');
    const screen = parseClaudeScreenState(rawText);

    expect(screen.composerContent).toBe('');
    expect(screen.userDraftPresent).toBe(false);
    expect(classifyScreen(rawText)).toBe('empty');
  });

  it('classifies the captured rate-limit resume screen as provider unavailable, not a foreign draft', () => {
    const rawText = readFixture('incident-89861-ratelimit-resume.ansi');
    const screen = parseClaudeScreenState(rawText);

    expect(screen.usageLimitDialogVisible).toBe(true);
    expect(screen.composerContent).toBe('/rate-limit-options');
    expect(screen.userDraftPresent).toBe(false);
    expect(classifyScreen(rawText)).toBe('provider_unavailable');
  });

  it('treats Claude resume prefill as empty composer content', () => {
    const rawText = boxedComposer('Continue where you left off');
    const screen = parseClaudeScreenState(rawText);

    expect(screen.composerContent).toBe('');
    expect(screen.userDraftPresent).toBe(false);
    expect(classifyScreen(rawText)).toBe('empty');
  });

  it.each([
    ['switch model dialog', ['Switch model?', '❯ 1. Yes, switch', '  2. No, go back']],
    ['resume choice dialog', ['This session is 22 days old and has 200000 tokens.', '❯ 1. Resume from summary', '  2. Resume full session']],
    ['effort dialog', ['Change effort level?', 'Switching to high means the full history will be used.', '❯ 1. Yes, switch to high', '  2. No, go back']],
    ['permission prompt', ['Do you want to proceed?', '❯ 1. Yes', '  2. No']],
    ['trust folder prompt', ['Do you trust the files in this folder?', '❯ 1. Yes, proceed', '  2. No, exit']],
    ['unrecognized confirmation dialog', ['What do you want to do?', '❯ 1. Stop and wait', '  2. Upgrade your plan']],
  ] as const)('does not classify composer-shaped text on %s as foreign', (_name, dialogLines) => {
    const rawText = [
      ...dialogLines,
      '',
      ...boxedComposer('Continue where you left off').split('\n'),
    ].join('\n');

    expect(classifyScreen(rawText)).toBe('non_input_state');
  });

  it('still classifies a genuine user-typed draft as foreign', () => {
    const esc = String.fromCharCode(0x1b);
    const rawText = boxedComposer(`${esc}[22mplease continue the parser fix after tests${esc}[0m`);
    const screen = parseClaudeScreenState(rawText);

    expect(screen.userDraftPresent).toBe(true);
    expect(classifyScreen(rawText)).toBe('foreign');
  });

  it('classifies controller-typed /effort residue in the observed composer shape as own', () => {
    const rawText = boxedComposer('/effort medium');
    const screen = parseClaudeScreenState(rawText);

    expect(screen.composerContent).toBe('/effort medium');
    expect(classifyScreen(rawText)).toBe('own');
  });

  it('classifies a non-dialog screen with no composer as non-input, not empty', () => {
    const rawText = [
      'Applied runtime control; transcript is redrawing',
      '  ⏵⏵ accept edits on (shift+tab to cycle)',
    ].join('\n');
    const screen = parseClaudeScreenState(rawText);

    expect(screen.composerContent).toBeNull();
    expect(screen.inputBoxInteractive).toBe(true);
    expect(classifyScreen(rawText)).toBe('non_input_state');
  });
});
