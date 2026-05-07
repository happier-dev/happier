import { describe, expect, it } from 'vitest';

import {
  DEFAULT_WINDOWS_TERMINAL_WINDOW_NAME,
  normalizeWindowsTerminalWindowName,
  WindowsTerminalWindowNameSchema,
} from './windowsTerminalWindowName.js';

describe('windowsTerminalWindowName', () => {
  it('normalizes empty and reserved Windows Terminal window names to the shared default', () => {
    expect(DEFAULT_WINDOWS_TERMINAL_WINDOW_NAME).toBe('happier');
    expect(normalizeWindowsTerminalWindowName('')).toBe('happier');
    expect(normalizeWindowsTerminalWindowName('   ')).toBe('happier');
    expect(normalizeWindowsTerminalWindowName('new')).toBe('happier');
    expect(normalizeWindowsTerminalWindowName('0')).toBe('happier');
  });

  it('preserves explicit named Windows Terminal windows', () => {
    expect(normalizeWindowsTerminalWindowName('  happier qa  ')).toBe('happier qa');
    expect(WindowsTerminalWindowNameSchema.parse('happier-dev')).toBe('happier-dev');
  });
});
