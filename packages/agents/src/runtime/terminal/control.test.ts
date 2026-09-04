import { describe, expect, it } from 'vitest';

import {
  TERMINAL_SHIFT_TAB_SEQUENCE,
  TERMINAL_SPECIAL_KEYS,
  type TerminalSpecialKey,
} from './control.js';

describe('terminal control contract', () => {
  it('emits the raw ESC [ Z back-tab sequence for Shift+Tab and never a named S-Tab', () => {
    // tmux's named `S-Tab` key was proven to do nothing; the literal bytes are mandatory.
    expect(TERMINAL_SHIFT_TAB_SEQUENCE.length).toBe(3);
    expect(TERMINAL_SHIFT_TAB_SEQUENCE.charCodeAt(0)).toBe(0x1b);
    expect(TERMINAL_SHIFT_TAB_SEQUENCE.slice(1)).toBe('[Z');
    expect(TERMINAL_SHIFT_TAB_SEQUENCE).not.toContain('S-Tab');
  });

  it('enumerates the supported special keys including navigation and ShiftTab', () => {
    const expected: readonly TerminalSpecialKey[] = [
      'Enter',
      'Escape',
      'ArrowUp',
      'ArrowDown',
      'Tab',
      'ShiftTab',
      'CtrlC',
      'Backspace',
    ];
    expect([...TERMINAL_SPECIAL_KEYS]).toEqual(expected);
    expect(TERMINAL_SPECIAL_KEYS).toContain('ShiftTab');
  });

  it('freezes the special-key list so callers cannot mutate the contract', () => {
    expect(Object.isFrozen(TERMINAL_SPECIAL_KEYS)).toBe(true);
  });
});
