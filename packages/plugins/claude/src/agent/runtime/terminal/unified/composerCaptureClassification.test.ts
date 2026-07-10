import { describe, expect, it } from 'vitest';

import { isClaudeComposerCaptureStyleUnavailablePlaceholderCandidate } from './composerCaptureClassification.js';
import { parseClaudeScreenState } from './screenState.js';

const ESC = String.fromCharCode(0x1b);

describe('composer capture classification', () => {
  it('treats styled chrome with an unstyled composer suggestion as style-unavailable', () => {
    const rawText = [
      `${ESC}[38;2;136;136;136m────────────────────────────────────────────────${ESC}[m`,
      '❯ check the output',
      `${ESC}[38;2;136;136;136m────────────────────────────────────────────────${ESC}[m`,
    ].join('\n');
    const screen = parseClaudeScreenState(rawText);

    expect(screen.composerContent).toBe('check the output');
    expect(isClaudeComposerCaptureStyleUnavailablePlaceholderCandidate(rawText, screen)).toBe(true);
  });

  it('does not treat composer-line style evidence as unavailable style', () => {
    const rawText = `❯ ${ESC}[2mcheck the output${ESC}[22m`;
    const screen = parseClaudeScreenState(rawText);

    expect(screen.composerContent).toBe('');
    expect(isClaudeComposerCaptureStyleUnavailablePlaceholderCandidate(rawText, screen)).toBe(false);
  });
});
