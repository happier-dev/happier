import { describe, expect, it } from 'vitest';

import {
  normalizeWindowsTerminalWindowName,
  WindowsTerminalWindowNameSchema,
} from './windowsTerminalWindowName.js';

describe('windowsTerminalWindowName', () => {
    it('preserves the explicit new-window selector while defaulting empty or ambient selectors', () => {
        expect(normalizeWindowsTerminalWindowName('')).toBe('happier');
        expect(normalizeWindowsTerminalWindowName('   ')).toBe('happier');
        expect(normalizeWindowsTerminalWindowName(' new ')).toBe('new');
        expect(normalizeWindowsTerminalWindowName('NEW')).toBe('new');
        expect(normalizeWindowsTerminalWindowName('-1')).toBe('happier');
        expect(normalizeWindowsTerminalWindowName('last')).toBe('happier');
        expect(normalizeWindowsTerminalWindowName('0')).toBe('happier');
    });

    it('preserves explicit shared Windows Terminal window names', () => {
        expect(normalizeWindowsTerminalWindowName('  happier qa  ')).toBe('happier qa');
        expect(WindowsTerminalWindowNameSchema.parse('happier-dev')).toBe('happier-dev');
    });

    it('rejects non-string values at schema validation while keeping the normalizer fallback explicit', () => {
        expect(normalizeWindowsTerminalWindowName({})).toBe('happier');
        expect(() => WindowsTerminalWindowNameSchema.parse({})).toThrow();
        expect(() => WindowsTerminalWindowNameSchema.parse(42)).toThrow();
    });
});
