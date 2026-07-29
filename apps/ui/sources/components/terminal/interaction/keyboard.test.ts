import { describe, expect, it } from 'vitest';

import { shouldTerminalCaptureKeyboardEvent } from './keyboard';

describe('shouldTerminalCaptureKeyboardEvent', () => {
    it('does not capture keys when the terminal is not focused', () => {
        expect(shouldTerminalCaptureKeyboardEvent({
            terminalFocused: false,
            key: 'Enter',
            modifiers: [],
        })).toBe(false);
    });

    it('leaves global copy shortcuts to host copy handling', () => {
        expect(shouldTerminalCaptureKeyboardEvent({
            terminalFocused: true,
            key: 'c',
            modifiers: ['ctrl'],
        })).toBe(false);
        expect(shouldTerminalCaptureKeyboardEvent({
            terminalFocused: true,
            key: 'C',
            modifiers: ['meta'],
        })).toBe(false);
    });

    it('captures terminal-local keys while focused', () => {
        expect(shouldTerminalCaptureKeyboardEvent({
            terminalFocused: true,
            key: 'Enter',
            modifiers: [],
        })).toBe(true);
        expect(shouldTerminalCaptureKeyboardEvent({
            terminalFocused: true,
            key: 'v',
            modifiers: ['ctrl'],
        })).toBe(true);
    });
});
