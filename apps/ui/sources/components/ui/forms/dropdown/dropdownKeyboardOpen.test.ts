import { describe, expect, it } from 'vitest';

import { openedFromKeyboard } from './dropdownKeyboardOpen';

/** The browser's own judgement is the boundary: an element that says whether it matches `:focus-visible`. */
function focused(tagName: string, focusVisible: boolean, editable = false) {
  return {
    tagName,
    isContentEditable: editable,
    matches: (selector: string) =>
      selector === ':focus-visible' && focusVisible,
  };
}

describe('openedFromKeyboard', () => {
  it('treats a menu whose trigger holds keyboard focus as opened from the keyboard', () => {
    expect(openedFromKeyboard(focused('BUTTON', true))).toBe(true);
    expect(openedFromKeyboard(focused('BUTTON', false))).toBe(false);
  });

  // Live 2026-11-10 (Account B, Assignees): a searchable menu focuses its field on open, and a focused text field
  // always matches :focus-visible, so a pointer open drew the first row's highlight.
  it('never reads a focused text field as a keyboard open', () => {
    expect(openedFromKeyboard(focused('INPUT', true))).toBe(false);
    expect(openedFromKeyboard(focused('TEXTAREA', true))).toBe(false);
    expect(openedFromKeyboard(focused('DIV', true, true))).toBe(false);
  });

  it('reads nothing when focus is nowhere', () => {
    expect(openedFromKeyboard(null)).toBe(false);
  });
});
