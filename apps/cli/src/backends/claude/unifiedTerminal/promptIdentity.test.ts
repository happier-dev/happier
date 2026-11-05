import { describe, expect, it } from 'vitest';

import {
  isClaudeUnifiedComposerTextMatch,
  normalizeClaudeUnifiedPromptIdentityText,
} from './promptIdentity';

/**
 * Observed contract (Claude Code 2.1.259, live incident 2026-09-18 session
 * cmtyf86rp1a1ttm237czmr4ts): a bracketed-paste prompt is recorded wrapped in paste markers.
 * The injected payload measured 2904 bytes / 12 newlines while the transcript row measured
 * 2962 bytes / 17 newlines — exactly the 26 + 27 marker characters plus 5 newlines.
 */
const PASTE_OPEN = '<pasted_content id="9b65">';
const PASTE_CLOSE = '</pasted_content id="9b65">';

describe('normalizeClaudeUnifiedPromptIdentityText', () => {
  it('reads a pasted prompt as the text Happier injected', () => {
    const injected = 'first line\n\nsecond line\nthird line';
    const recordedByProvider = `\n\n${PASTE_OPEN}\n${injected}\n${PASTE_CLOSE}\n`;

    expect(normalizeClaudeUnifiedPromptIdentityText(recordedByProvider))
      .toBe(normalizeClaudeUnifiedPromptIdentityText(injected));
  });

  it('keeps marker-looking prose that is not a standalone paste marker', () => {
    const prompt = `explain ${PASTE_OPEN} in the parser`;

    expect(normalizeClaudeUnifiedPromptIdentityText(prompt)).toBe(prompt);
  });

  it('distinguishes two different pasted prompts', () => {
    const left = `${PASTE_OPEN}\nship the release\n${PASTE_CLOSE}`;
    const right = `${PASTE_OPEN}\nrevert the release\n${PASTE_CLOSE}`;

    expect(normalizeClaudeUnifiedPromptIdentityText(left))
      .not.toBe(normalizeClaudeUnifiedPromptIdentityText(right));
  });

  it('matches Claude native paste tab expansion without ignoring other indentation changes', () => {
    // Claude Code 2.1.316's native editor expands every pasted tab to four spaces.
    const injected = 'History:\n\tconst value = 1;\n\t\treturn value;\nReply only ok';
    const recorded = `${PASTE_OPEN}\nHistory:\n    const value = 1;\n        return value;\nReply only ok\n${PASTE_CLOSE}`;

    expect(normalizeClaudeUnifiedPromptIdentityText(recorded))
      .toBe(normalizeClaudeUnifiedPromptIdentityText(injected));
    expect(normalizeClaudeUnifiedPromptIdentityText(recorded.replace('    const', '  const')))
      .not.toBe(normalizeClaudeUnifiedPromptIdentityText(injected));
    expect(normalizeClaudeUnifiedPromptIdentityText(recorded.replace('value = 1', 'value = 2')))
      .not.toBe(normalizeClaudeUnifiedPromptIdentityText(injected));
  });

  it('matches a pasted prompt against the composer rendering of the injected text', () => {
    const injected = 'please review the queue drain\nand report back';

    expect(isClaudeUnifiedComposerTextMatch({
      promptText: `${PASTE_OPEN}\n${injected}\n${PASTE_CLOSE}`,
      composerText: injected,
    })).toBe(true);
  });

  it('matches visual wraps inside tokens without matching changed token content', () => {
    const prompt = 'Check https://example.invalid/?q=' + 'a'.repeat(90) + ' and {"key":"value"}';
    const wrapped = `Check https://example.invalid/?q=${'a'.repeat(50)}\n${'a'.repeat(40)} and {"key":"val\nue"}`;

    expect(isClaudeUnifiedComposerTextMatch({ promptText: prompt, composerText: wrapped })).toBe(true);
    expect(isClaudeUnifiedComposerTextMatch({
      promptText: prompt,
      composerText: wrapped.replace('val\nue', 'bad\nue'),
    })).toBe(false);
    expect(isClaudeUnifiedComposerTextMatch({
      promptText: prompt,
      composerText: wrapped.replace('a'.repeat(40), 'b'.repeat(40)),
    })).toBe(false);
  });
});
